// pnpm e2e:ng — the Nigeria demo end to end on testnet, through the real Edge Functions, as the app
// does it (Funmi's and Mama Bisi's demo logins). Run by hand; it moves testnet money.
//
//   The 60-second demo (README "Demo"), as the app does it:
//   1. Balance.  2. Pay Iya Tunde ₦2,000.  3. Pay ajo.  4. Save ₦1,000 (the Stall shade pot).
//   5. Loan offer.  6. Accept with the PIN (a test PIN, set for the run and removed after it;
//      refused without it and with a wrong one; confirming twice returns the same result).
//   7. Share her record.  8. A lender verifies the code through /verify's public call.
//   9. A ₦3,000 cash-out code; Mama Bisi checks and redeems it.
//   Then every transaction is checked on Horizon and listed with its Stellar Expert link.
//
//   --all adds a new person, from sign-up to first payment (a test number, re-runnable: the
//   earlier test person is archived; wrong NIN refused, wallet opened, bank transfer in, first
//   payment, a payment by code that Mama Bisi pays out, signing in again with phone + PIN).
//
// Timing: "Yes -> tick" is from sending confirm_action until the transactions row is completed
// (the app's tick: chain-worker saw it in a closed ledger and refreshed the balance cache).
//
//   pnpm e2e:ng            the 60-second demo (run pnpm demo:reset ng first: it needs the loan
//                          offer, an unpaid ajo round, and Funmi without a PIN)
//   pnpm e2e:ng --all      the demo, then a new person from sign-up to first payment
//   pnpm e2e:ng --read     read-only tools and timings; moves nothing
//   pnpm e2e:ng --new-user only the new person
//
// Needs: pnpm seed && pnpm seed:db; Supabase secrets STELLAR_SECRET_FUNMI, STELLAR_SECRET_AGENT_NG,
// CASHOUT_CODE_SECRET; pnpm demo:reset ng just before.
// Prints no secrets (the cash-out code is a one-time testnet code and is shown masked).
import { createClient } from "@supabase/supabase-js";
import { adminClient, loadLocalEnv } from "./lib/supabase-admin.ts";
import { plusFetch, signIn, signUp, testNin, testPin } from "./lib/onboard.ts";

loadLocalEnv();
const { db: admin, url } = adminClient();
const HORIZON = "https://horizon-testnet.stellar.org";
const EXPERT = "https://stellar.expert/explorer/testnet";
const FUNMI_PHONE = "+2340000000501";
const readOnly = process.argv.includes("--read");
const newUserOnly = process.argv.includes("--new-user");
const NEW_USER_PHONE = "+2347000000301"; // a test number: each run archives the previous e2e person
const OUTSIDER_PHONE = "+2348035550101"; // not on Plus: paid by code
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

async function login(email: string) {
  const c = createClient(url, process.env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password: process.env.VITE_DEMO_LOGIN_PASSWORD! });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  return data.session.access_token;
}

function caller(fn: string, token: string) {
  return async (name: string, body: Json = {}): Promise<Json & { ms: number }> => {
    const t0 = Date.now();
    const r = await fetch(`${url}/functions/v1/${fn}/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const j = await r.json() as Json;
    return { ...j, http: r.status, ms: Date.now() - t0 };
  };
}

async function job(name: string) {
  const r = await fetch(`${url}/functions/v1/${name}`, { method: "POST", headers: { "x-plus-secret": process.env.AGENT_SHARED_SECRET! }, body: "{}" });
  return await r.json().catch(() => ({})) as Json;
}

/** Wait until the transactions row is completed (the tick) and return its hash and the time. */
async function tick(txId: string, t0: number): Promise<{ ms: number; hash: string }> {
  for (;;) {
    const { data } = await admin.from("transactions").select("status, chain_tx_hash").eq("id", txId).single();
    if (data?.status === "completed" && data.chain_tx_hash) return { ms: Date.now() - t0, hash: data.chain_tx_hash };
    if (data?.status === "failed") throw new Error(`transaction ${txId} failed`);
    if (Date.now() - t0 > 120_000) {
      const { data: rows } = await admin.from("chain_outbox").select("id, signer, kind, status, last_error").eq("args->>transaction_id", txId);
      throw new Error(`transaction ${txId} not on-chain after 2 min: ${JSON.stringify(rows)}`);
    }
    await sleep(200);
  }
}

async function outboxDone(id: number, t0: number): Promise<{ ms: number; hash: string; result: Json | null }> {
  for (;;) {
    const { data } = await admin.from("chain_outbox").select("status, tx_hash, last_error, result").eq("id", id).single();
    if (data?.status === "done") return { ms: Date.now() - t0, hash: data.tx_hash, result: data.result };
    if (data?.status === "failed" && Date.now() - t0 > 30_000) throw new Error(`outbox ${id} failed: ${data.last_error}`);
    if (Date.now() - t0 > 120_000) throw new Error(`outbox ${id} still ${data?.status}`);
    await sleep(200);
  }
}

async function onHorizon(hash: string): Promise<boolean> {
  const r = await fetch(`${HORIZON}/transactions/${hash}`);
  return r.ok && (await r.json() as { successful: boolean }).successful;
}

const rows: { step: string; ms: number; hash: string }[] = [];
function done(step: string, t: { ms: number; hash: string }) {
  rows.push({ step, ...t });
  console.log(`  ✓ ${step}: Yes -> tick ${(t.ms / 1000).toFixed(1)} s  ${EXPERT}/tx/${t.hash}`);
}
function must(r: Json, what: string) {
  if (r.ok === false || r.error) throw new Error(`${what}: ${r.error} ${r.text ?? ""}`);
  return r;
}

async function main() {
  const funmi = caller("agent-tools", await login("demo-funmi@example.com"));
  const bisi = caller("agent-api", await login("demo-mamabisi@example.com"));
  if (newUserOnly) {
    await newUser(bisi);
    return report();
  }

  console.log("Read paths (app -> agent-tools; balances from the cache, contract views by simulation)");
  const sched = await job("scheduler");
  console.log(`  scheduler: ${JSON.stringify(sched.balances)} (Horizon read for every Nigeria wallet), ${sched.ms} ms`);
  for (const t of ["get_balance", "what_arrived", "group_status", "savings_status", "loan_status", "my_record"]) {
    const r = await funmi(t);
    console.log(`  ${t.padEnd(15)} ${String(r.ms).padStart(5)} ms  ${r.text}`);
  }
  const me = await bisi("me");
  console.log(`  agent me        ${String(me.ms).padStart(5)} ms  float ${me.float_text} (${me.float_free_text} free; Horizon ${me.horizon_ms} ms), left today ${me.left_today_text}`);
  if (readOnly) return;

  const funmiId = (await admin.from("users").select("id").eq("wa_phone", FUNMI_PHONE).is("archived_at", null).single()).data!.id as string;
  const pins = (await admin.from("user_credentials").select("user_id", { count: "exact", head: true }).eq("user_id", funmiId)).count ?? 0;
  if (pins > 0) throw new Error("Funmi already has a PIN: run pnpm demo:reset ng first (the e2e sets a test PIN and removes it again)");
  try {
    await demo(funmi, bisi, funmiId);
  } finally {
    // As found: the demo login has no PIN (the app asks for one the first time it is needed).
    await admin.from("user_credentials").delete().eq("user_id", funmiId);
  }
  if (process.argv.includes("--all")) await newUser(bisi);
  await report();
}

/** The 60-second demo (README "Demo"), by the same tool calls the app makes. */
async function demo(funmi: ReturnType<typeof caller>, bisi: ReturnType<typeof caller>, funmiId: string) {
  const pin = testPin(); // a fresh test PIN for this run; never printed
  const yes = async (actionId: string, what: string) => {
    let c = await funmi("confirm_action", { action_id: actionId });
    if (c.error === "pin_required") c = await funmi("confirm_action", { action_id: actionId, pin });
    return must(c, what);
  };

  console.log("\n1. Balance");
  const b = must(await funmi("get_balance"), "get_balance");
  console.log(`  ${b.text} (${b.ms} ms)`);

  console.log("\n2. Pay Iya Tunde ₦2,000");
  const p = must(await funmi("prepare_pay", { payee: "Iya Tunde", amount: "2000" }), "prepare_pay");
  console.log(`  read-back: ${p.text}`);
  let t0 = Date.now();
  let c = await yes(p.action_id, "confirm pay");
  console.log(`  confirm answered in ${c.ms} ms`);
  done("pay Iya Tunde ₦2,000 (payment, fee-bumped by partner)", await tick(c.transaction_id, t0));

  console.log("\n3. Pay ajo");
  const g = must(await funmi("prepare_ajo_contribution"), "prepare_ajo_contribution");
  console.log(`  read-back: ${g.text}`);
  t0 = Date.now();
  c = await yes(g.action_id, "confirm ajo");
  done("Bodija Market Ajo (group_contribute, contract call)", await tick(c.transaction_id, t0));

  console.log("\n4. Save ₦1,000");
  const sv = must(await funmi("prepare_save", { amount: "1000" }), "prepare_save");
  console.log(`  read-back: ${sv.text}`);
  t0 = Date.now();
  c = await yes(sv.action_id, "confirm save");
  done("save ₦1,000 into Stall shade (pot_fund, contract call)", await tick(c.transaction_id, t0));
  console.log(`  ${(await funmi("savings_status")).text}`);

  console.log("\n5. Loan offer");
  const ls = must(await funmi("loan_status"), "loan_status");
  if (ls.view !== "offer") throw new Error(`loan_status: expected an offer, got ${ls.view}: ${ls.text}`);
  console.log(`  ${ls.text}`);

  console.log("\n6. Accept (PIN)");
  must(await funmi("set_pin", { pin }), "set_pin");
  console.log("  a test PIN set on the screen (removed again after the run)");
  const l = must(await funmi("prepare_loan"), "prepare_loan");
  console.log(`  read-back: ${l.text}`);
  const noPin = await funmi("confirm_action", { action_id: l.action_id });
  if (noPin.error !== "pin_required") throw new Error(`a loan must need the PIN, got ${noPin.error ?? noPin.status}`);
  const bad = await funmi("confirm_action", { action_id: l.action_id, pin: pin === "2580" ? "2581" : "2580" });
  if (bad.ok !== false) throw new Error("a wrong PIN was accepted");
  console.log(`  without the PIN -> ${noPin.error}; a wrong PIN -> ${bad.error}`);
  t0 = Date.now();
  c = must(await funmi("confirm_action", { action_id: l.action_id, pin }), "confirm loan");
  console.log(`  confirm answered in ${c.ms} ms: ${c.text}`);
  done("loan paid out (lending_ng -> Funmi; loan_open on plus_credit)", await tick(c.transaction_id, t0));
  const again = await funmi("confirm_action", { action_id: l.action_id, pin });
  if (again.transaction_id !== c.transaction_id) throw new Error("confirming the loan twice did not return the same result");
  console.log(`  ${(await funmi("loan_status")).text}`);

  console.log("\n7. Share her record");
  const sh = must(await funmi("share_record"), "share_record");
  c = await yes(sh.action_id, "confirm share");
  const shareCode = String(c.share_code ?? "");
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(shareCode)) throw new Error(`no share code on the screen: ${JSON.stringify(c.share_code)}`);
  console.log(`  code on Funmi's screen: ${shareCode.slice(0, 2)}**-****, until ${c.share_expires_at}`);

  console.log("\n8. A lender verifies it (/verify: the public verify_record call, no login)");
  const anon = createClient(url, process.env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  t0 = Date.now();
  const { data: v, error: ve } = await anon.rpc("verify_record", { p_code: shareCode });
  if (ve) throw new Error(`verify_record: ${ve.message}`);
  const wallet = (await admin.from("users").select("stellar_pub").eq("id", funmiId).single()).data!.stellar_pub;
  if (!v?.ok || v.wallet !== wallet || !/^[0-9a-f]{64}$/.test(String(v.borrower_ref))) throw new Error(`verify_record: ${JSON.stringify(v)}`);
  console.log(`  ✓ ${Date.now() - t0} ms: her wallet and a 32-byte reference (no name, no phone); the page reads the rest from Stellar`);
  const wrong = await anon.rpc("verify_record", { p_code: "AAAA-AAAA" });
  console.log(`  a wrong code -> ${wrong.data?.error ?? wrong.error?.message}`);

  console.log("\n9. Cash-out code for ₦3,000; Mama Bisi pays it out");
  const o = must(await funmi("prepare_cashout", { amount: "3000" }), "prepare_cashout");
  console.log(`  read-back: ${o.text}`);
  t0 = Date.now();
  c = await yes(o.action_id, "confirm cash-out");
  const code = String(c.cash_out_code);
  if (!/^\d{6}$/.test(code)) throw new Error("no cash-out code on the screen");
  console.log(`  code on Funmi's screen: ${code.slice(0, 2)}****`);
  done("cash-out ₦3,000 (claimable balance, reserve sponsored by partner)", await tick(c.transaction_id, t0));
  must(await bisi("check_code", { phone: FUNMI_PHONE, code }), "check_code");
  t0 = Date.now();
  must(await bisi("redeem_code", { phone: FUNMI_PHONE, code }), "redeem_code");
  const { data: co } = await admin.from("cash_out_codes").select("claim_outbox_id").eq("action_id", o.action_id).single();
  done("Mama Bisi claims the cash-out (claimable balance claim)", await outboxDone(co!.claim_outbox_id, t0));
  console.log(`\n  ${(await funmi("get_balance")).text}`);
}

async function newUser(bisi: ReturnType<typeof caller>) {
  console.log("\n8. A new person: sign-up to first payment");
  const pin = testPin();
  const t0 = Date.now();
  const u = await signUp(url, process.env.VITE_SUPABASE_ANON_KEY!, {
    name: "Adaeze Okafor",
    language: "en",
    phone: NEW_USER_PHONE,
    pin,
    nin: testNin(),
    tryWrongNin: true,
    trusted: { name: "Chidi", phone: "0803 555 0199" },
  }, console.log);
  const signupMs = u.steps.reduce((s, x) => s + x.ms, 0);
  console.log(`  sign-up: ${u.steps.length} steps, ${(signupMs / 1000).toFixed(1)} s of server time; tier ${u.tier}; account ${u.virtualAccount}`);
  rows.push({ step: "new wallet (sponsored account + NGNT/USDC trustlines)", ms: u.walletMs, hash: u.walletTx!.split("/tx/")[1] });
  const adaeze = caller("agent-tools", u.accessToken);

  console.log("  bank transfer in (Partner bank, simulated): ₦5,000");
  let t = Date.now();
  const b = must(await adaeze("simulate_bank_transfer", { amount: "5000", sender: "Chidi Okeke" }), "simulate_bank_transfer");
  done("bank transfer in ₦5,000 (anchor_ng -> her wallet)", await tick(b.transaction_id, t));
  console.log(`  she hears: ${(await adaeze("what_arrived")).text}`);

  console.log("  her first payment: ₦500 to Funmi by phone (a Plus user)");
  const p = must(await adaeze("prepare_pay", { phone: FUNMI_PHONE, amount: "500" }), "prepare_pay to Funmi");
  console.log(`  read-back: ${p.text}`);
  t = Date.now();
  const c = must(await adaeze("confirm_action", { action_id: p.action_id }), "confirm pay Funmi");
  const paid = await tick(c.transaction_id, t);
  done("first payment ₦500 to Funmi (wallet to wallet)", paid);
  const { data: theirs } = await admin.from("transactions").select("status, chain_tx_hash").eq("ref", `received:${p.action_id}`).single();
  console.log(`  Funmi's side: ${theirs?.status}, same transaction: ${theirs?.chain_tx_hash === paid.hash}`);
  must(await adaeze("save_payee", { name: "Funmi (tomatoes)", phone: FUNMI_PHONE }), "save_payee");
  console.log("  saved Funmi as a payee");

  console.log("  ₦300 by phone to someone not on Plus: a code they collect at Mama Bisi");
  const q = must(await adaeze("prepare_pay", { phone: OUTSIDER_PHONE, name: "Mama Ngozi", amount: "300" }), "prepare_pay by code");
  console.log(`  read-back: ${q.text}`);
  t = Date.now();
  const cq = must(await adaeze("confirm_action", { action_id: q.action_id }), "confirm pay by code");
  const sms = cq.pay_code_sms as { to: string; code: string; text: string };
  console.log(`  simulated SMS to ${sms.to}: ${sms.text.replace(sms.code, `${sms.code.slice(0, 2)}****`)}`);
  done("pay by code ₦300 (claimable balance for agents)", await tick(cq.transaction_id, t));
  must(await bisi("check_code", { phone: OUTSIDER_PHONE, code: sms.code }), "agent check_code");
  t = Date.now();
  must(await bisi("redeem_code", { phone: OUTSIDER_PHONE, code: sms.code }), "agent redeem_code");
  const { data: co } = await admin.from("cash_out_codes").select("claim_outbox_id").eq("action_id", q.action_id).single();
  done("Mama Bisi pays Mama Ngozi out (claims the balance)", await outboxDone(co!.claim_outbox_id, t));

  console.log("  limits: a tier-2 day is ₦200,000; she cannot send ₦250,000");
  const over = await adaeze("prepare_pay", { phone: FUNMI_PHONE, amount: "250000" });
  console.log(`  -> ${over.error}: ${over.text}`);

  console.log("  sign in again with phone + PIN");
  t = Date.now();
  await signIn(url, process.env.VITE_SUPABASE_ANON_KEY!, NEW_USER_PHONE, pin);
  const wrong = await plusFetch(url)("agent-tools/sign_in", { market: "ng", phone: NEW_USER_PHONE, pin: pin === "2580" ? "1357" : "2580" });
  console.log(`  ✓ signed in (${Date.now() - t} ms); a wrong PIN -> ${wrong.error}`);
  console.log(`  sign-up to first payment: ${((Date.now() - t0) / 1000).toFixed(1)} s in all  ${EXPERT}/account/${u.wallet}`);
}

async function report() {
  console.log("\nVerify on Stellar (Horizon)");
  for (const r of rows) console.log(`  ${(await onHorizon(r.hash)) ? "✓" : "✗"} ${r.step}  ${EXPERT}/tx/${r.hash}`);
  const ms = rows.map((r) => r.ms).sort((x, y) => x - y);
  console.log(`\nYes -> tick: median ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)} s, max ${(ms.at(-1)! / 1000).toFixed(1)} s over ${ms.length} transactions`);
  console.log(`Funmi's wallet: ${EXPERT}/account/${(await admin.from("users").select("stellar_pub").eq("wa_phone", FUNMI_PHONE).single()).data!.stellar_pub}`);
}

main().catch((err) => {
  console.error(`e2e:ng failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
