// pnpm e2e:ng — the Nigeria demo end to end on testnet, through the real Edge Functions, as the app
// does it (Funmi's and Mama Bisi's demo logins). Run by hand; it moves testnet money.
//
//   1. Mama Bisi records ₦500 cash; Funmi says Yes; NGNT moves from Mama Bisi's float to Funmi.
//   2. Funmi pays Iya Tunde ₦5,000.
//   3. Funmi pays her Bodija Market Ajo contribution (₦1,000, contract call).
//   4. Funmi takes a ₦20,000 advance (fee ₦300).
//   5. Mama Bisi records ₦3,000 cash; Funmi's Yes sends it and repays 10% (₦300) of her advance.
//   6. Funmi cashes out ₦2,000: a claimable balance plus a code; Mama Bisi redeems the code.
//   7. Every transaction is checked on Horizon and listed with its Stellar Expert link.
//   8. A new person, from sign-up to first payment: the real sign-up on a test number (re-runnable:
//      the earlier test person is archived), a wrong NIN refused, the wallet opened on Stellar, a
//      bank transfer in, her first payment (to Funmi, a Plus user, by phone), a payment by code to
//      someone not on Plus that Mama Bisi pays out, and signing in again with phone + PIN.
//
// Timing: "Yes -> tick" is from sending confirm_action until the transactions row is completed
// (the app's tick: chain-worker saw it in a closed ledger and refreshed the balance cache).
//
//   pnpm e2e:ng            the whole demo
//   pnpm e2e:ng --read     read-only tools and timings (balance, ajo, advance, record); moves nothing
//   pnpm e2e:ng --new-user only step 8 (sign-up to first payment)
//
// Needs: pnpm seed && pnpm seed:db; Supabase secrets STELLAR_SECRET_FUNMI, STELLAR_SECRET_AGENT_NG,
// CASHOUT_CODE_SECRET; Funmi's ajo round not yet paid; no advance open (for steps 3 and 4).
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
  for (const t of ["get_balance", "what_arrived", "group_status", "advance_status", "my_record"]) {
    const r = await funmi(t);
    console.log(`  ${t.padEnd(15)} ${String(r.ms).padStart(5)} ms  ${r.text}`);
  }
  const me = await bisi("me");
  console.log(`  agent me        ${String(me.ms).padStart(5)} ms  float ${me.float_text} (${me.float_free_text} free; Horizon ${me.horizon_ms} ms), left today ${me.left_today_text}`);
  if (readOnly) return;

  console.log("\n1. Mama Bisi records ₦500 cash; Funmi says Yes");
  const key = () => `e2e-ng-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  must(await bisi("record_cash_in", { phone: FUNMI_PHONE, amount: "500", idempotency_key: key() }), "record_cash_in");
  const waiting = (await funmi("what_arrived")).awaiting_confirmation as Json[];
  console.log(`  Funmi hears: ${(await funmi("what_arrived")).text.split(". ")[0]}.`);
  const ci = waiting[0];
  let t0 = Date.now();
  let c = must(await funmi("confirm_action", { action_id: ci.pending_action_id }), "confirm cash-in");
  console.log(`  confirm answered in ${c.ms} ms: ${c.text}`);
  done("cash-in ₦500 (Mama Bisi float -> Funmi, payment via Horizon)", await tick(c.transaction_id, t0));

  console.log("\n2. Pay Iya Tunde ₦5,000");
  const p = must(await funmi("prepare_pay", { payee: "Iya Tunde", amount: "5000" }), "prepare_pay");
  console.log(`  read-back: ${p.text}`);
  t0 = Date.now();
  c = must(await funmi("confirm_action", { action_id: p.action_id }), "confirm pay");
  done("pay Iya Tunde ₦5,000 (payment, fee-bumped by partner)", await tick(c.transaction_id, t0));

  console.log("\n3. Ajo contribution");
  const g = must(await funmi("prepare_ajo_contribution"), "prepare_ajo_contribution");
  console.log(`  read-back: ${g.text}`);
  t0 = Date.now();
  c = must(await funmi("confirm_action", { action_id: g.action_id }), "confirm ajo");
  done("Bodija Market Ajo ₦1,000 (group_contribute, contract call via RPC)", await tick(c.transaction_id, t0));
  console.log(`  ${(await funmi("group_status")).text}`);

  console.log("\n4. Advance ₦20,000");
  const a = must(await funmi("prepare_advance", { amount: "20000" }), "prepare_advance");
  console.log(`  read-back: ${a.text}`);
  t0 = Date.now();
  c = must(await funmi("confirm_action", { action_id: a.action_id }), "confirm advance");
  done("advance ₦20,000 (request_advance, contract call)", await tick(c.transaction_id, t0));
  console.log(`  ${(await funmi("advance_status")).text}`);

  console.log("\n5. Next cash-in repays 10%");
  must(await bisi("record_cash_in", { phone: FUNMI_PHONE, amount: "3000", idempotency_key: key() }), "record_cash_in 2");
  const ci2 = ((await funmi("what_arrived")).awaiting_confirmation as Json[])[0];
  t0 = Date.now();
  c = must(await funmi("confirm_action", { action_id: ci2.pending_action_id }), "confirm cash-in 2");
  console.log(`  ${c.text}`);
  done("cash-in ₦3,000 (payment)", await tick(c.transaction_id, t0));
  done("auto-repay ₦300 (repay, contract call, waits for the cash-in)", await tick(c.result.repay_transaction_id, t0));
  console.log(`  ${(await funmi("advance_status")).text}`);

  console.log("\n6. Cash out ₦2,000 with a code; Mama Bisi redeems it");
  const o = must(await funmi("prepare_cashout", { amount: "2000" }), "prepare_cashout");
  console.log(`  read-back: ${o.text}`);
  t0 = Date.now();
  c = must(await funmi("confirm_action", { action_id: o.action_id }), "confirm cash-out");
  const code = String(c.cash_out_code);
  console.log(`  code on Funmi's screen: ${code.slice(0, 2)}****`);
  done("cash-out ₦2,000 (claimable balance, reserve sponsored by partner)", await tick(c.transaction_id, t0));
  const wrong = await bisi("check_code", { phone: FUNMI_PHONE, code: code === "000000" ? "111111" : "000000" });
  console.log(`  wrong code -> ${wrong.error} (${wrong.attempts_left} tries left)`);
  must(await bisi("check_code", { phone: FUNMI_PHONE, code }), "check_code");
  t0 = Date.now();
  must(await bisi("redeem_code", { phone: FUNMI_PHONE, code }), "redeem_code");
  const { data: co } = await admin.from("cash_out_codes").select("claim_outbox_id, status").eq("action_id", o.action_id).single();
  done("Mama Bisi claims the cash-out (claimable balance claim)", await outboxDone(co!.claim_outbox_id, t0));
  const again = await bisi("redeem_code", { phone: FUNMI_PHONE, code });
  console.log(`  same code again -> ${again.error ?? "ok"}`);

  await newUser(bisi);
  await report();
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
  console.log("\n7. Verify on Stellar (Horizon)");
  for (const r of rows) console.log(`  ${(await onHorizon(r.hash)) ? "✓" : "✗"} ${r.step}  ${EXPERT}/tx/${r.hash}`);
  const ms = rows.map((r) => r.ms).sort((x, y) => x - y);
  console.log(`\nYes -> tick: median ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)} s, max ${(ms.at(-1)! / 1000).toFixed(1)} s over ${ms.length} transactions`);
  console.log(`Funmi's wallet: ${EXPERT}/account/${(await admin.from("users").select("stellar_pub").eq("wa_phone", FUNMI_PHONE).single()).data!.stellar_pub}`);
}

main().catch((err) => {
  console.error(`e2e:ng failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
