// pnpm e2e — end-to-end run against the dev project and Stellar testnet (by hand, not CI).
//
//   1. state transfer arrives (payout-sim)            -> Rs 1,000 in, 10% auto-saved
//   2. what_arrived (voice)                           -> mentions it
//   3. pay the flower wholesaler Rs 300               -> prepared by voice ("poo kadai"), Yes tapped in the app
//   4. helper cash-in                                 -> Meena records Rs 500 on the helper page, Selvi says Yes
//   5. my_record
//   6. wait for chain_outbox, then check every contract event on-chain (RPC), and time
//      "confirmed in Plus" -> "attest in a closed ledger".
//
// Voice calls go to agent-tools exactly as ElevenLabs sends them (x-plus-secret + plus_session from
// voice-session); app calls carry Selvi's login. Needs `pnpm seed:db` first. Prints no secrets.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { rpc as stellarRpc, scValToNative } from "@stellar/stellar-sdk";
import { adminClient, loadLocalEnv } from "./lib/supabase-admin.ts";

loadLocalEnv();

const { db: admin, url } = adminClient();
const FN = `${url}/functions/v1`;
const SECRET = process.env.AGENT_SHARED_SECRET!;
const PASSWORD = process.env.VITE_DEMO_LOGIN_PASSWORD!;
const CONTRACT = process.env.PLUS_CONTRACT_ID || "CA4VEZZOSQR3RLPN2SF4FLAB5FVPLYH3C635ZSSIEJDE4ZPADGMFQJP4";
const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const RUN = randomUUID().slice(0, 8);
const started = new Date();
if (!SECRET || !PASSWORD) throw new Error("AGENT_SHARED_SECRET and VITE_DEMO_LOGIN_PASSWORD must be in .env.local (run pnpm seed:db)");

const log = (s: string) => console.log(s);
const ok = (cond: unknown, what: string) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  log(`  ✓ ${what}`);
};

async function login(email: string): Promise<{ client: SupabaseClient; token: string }> {
  const client = createClient(url, process.env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  return { client, token: data.session.access_token };
}

async function post(path: string, body: Record<string, unknown>, headers: Record<string, string>) {
  const r = await fetch(`${FN}/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const j = await r.json() as Record<string, any>;
  return { status: r.status, ...j };
}

async function main() {
  log(`Plus e2e run ${RUN}  (${started.toISOString()})\n`);
  const selvi = await login("demo-selvi@example.com");
  const meena = await login("demo-meena@example.com");
  const app = (tool: string, body: Record<string, unknown> = {}) => post(`agent-tools/${tool}`, body, { authorization: `Bearer ${selvi.token}` });

  // Voice session, as the app's mic button does it.
  const vs = await post("voice-session", {}, { authorization: `Bearer ${selvi.token}` });
  let voice: (tool: string, body?: Record<string, unknown>) => ReturnType<typeof post>;
  if (vs.status === 200) {
    ok(vs.signed_url?.startsWith("wss://") && vs.plus_session, "voice-session: ElevenLabs signed URL + plus_session");
    voice = (tool, body = {}) => post(`agent-tools/${tool}`, { ...body, plus_session: vs.plus_session }, { "x-plus-secret": SECRET });
    const bad = await post("agent-tools/get_balance", { plus_session: vs.plus_session.slice(0, -3) + "AAA" }, { "x-plus-secret": SECRET });
    ok(bad.status === 401, "tampered plus_session -> 401");
  } else {
    throw new Error(`voice-session failed: ${vs.status} ${vs.error}`);
  }

  const before = await voice("get_balance");
  log(`\nStart: ${before.balance_text} to spend, ${before.savings_text} saved`);

  // 1. State transfer
  log("\n1. State transfer arrives");
  const st = await post("payout-sim/state_transfer_arrives", { idempotency_key: `e2e-${RUN}-dbt` }, { authorization: `Bearer ${selvi.token}` });
  ok(st.ok, `payout-sim: ${st.text}`);
  const again = await post("payout-sim/state_transfer_arrives", { idempotency_key: `e2e-${RUN}-dbt` }, { authorization: `Bearer ${selvi.token}` });
  ok(again.transaction_id === st.transaction_id && again.balance_text === st.balance_text, "same idempotency key: credited once");
  const afterDbt = await voice("get_balance");
  const d = (a: string, b: string) => Number(a) - Number(b);
  ok(d(afterDbt.balance_minor, before.balance_minor) === 90000 && d(afterDbt.savings_minor, before.savings_minor) === 10000,
    `auto-save: +₹900 to spend, +₹100 saved (${afterDbt.balance_text} / ${afterDbt.savings_text})`);

  // 2. what_arrived
  log("\n2. what_arrived (voice)");
  const wa = await voice("what_arrived");
  log(`  agent hears: "${wa.text}"`);
  ok(/1,000 rupees from the state transfer/.test(wa.text), "mentions the state transfer, in rupees");
  ok(!/dollar|\$/i.test(wa.text), "never says dollars");

  // 3. Pay the flower wholesaler Rs 300
  log("\n3. Pay the flower wholesaler ₹300 (voice prepares, app taps Yes)");
  const pp = await voice("prepare_pay", { payee: "poo kadai", amount: 300 });
  log(`  agent hears: "${pp.text}"`);
  ok(pp.ok && pp.readback === "₹300 to flower wholesaler" && pp.requires_pin === false, "read-back ₹300 to flower wholesaler, no PIN needed");
  const { data: seen } = await selvi.client.from("pending_actions").select("id, status").eq("id", pp.action_id).single();
  ok(seen?.status === "pending", "app can read the pending action (RLS) -> confirm screen opens");
  const payConfirmAt = new Date();
  const pc = await app("confirm_action", { action_id: pp.action_id });
  ok(pc.status === "done", `app Yes: ${pc.text}`);
  const pc2 = await voice("confirm_action", { action_id: pp.action_id });
  ok(pc2.status === "done" && pc2.result?.transaction_id === pc.result?.transaction_id, "a second confirm returns the stored result (no double pay)");

  // Piece 13: the seettu (community savings) is retired; no group contribution step any more.

  // 4. Helper cash-in
  log("\n4. Helper cash-in (Meena records ₹500, Selvi says Yes)");
  const me = await post("helper-api/me", {}, { authorization: `Bearer ${meena.token}` });
  const selviRow = (me.people as { user_id: string; name: string }[]).find((p) => p.name === "Selvi");
  ok(selviRow, `helper page lists Selvi (Meena can record ${me.left_today_text} more today)`);
  const rec = await post("helper-api/record_cash_in", { user_id: selviRow!.user_id, amount: 500, idempotency_key: `e2e-${RUN}-cash` }, {
    authorization: `Bearer ${meena.token}`,
  });
  ok(rec.ok && rec.cash_event?.status === "awaiting_user", `helper: ${rec.text}`);
  const over = await post("helper-api/record_cash_in", { user_id: selviRow!.user_id, amount: 25000, idempotency_key: `e2e-${RUN}-over` }, {
    authorization: `Bearer ${meena.token}`,
  });
  ok(over.status === 409, `over the daily limit is refused: "${over.text}"`);
  const gu = await voice("get_user");
  ok(/Meena says she gave 500 rupees in cash/.test(gu.text), "get_user tells the agent to ask about the cash first");
  const { data: pa } = await admin.from("cash_events").select("pending_action_id").eq("id", rec.cash_event.id).single();
  const balBeforeCash = await voice("get_balance");
  const cashConfirmAt = new Date();
  const cc = await voice("confirm_action", { action_id: pa!.pending_action_id });
  ok(cc.status === "done", `voice yes: ${cc.text}`);
  const balAfterCash = await voice("get_balance");
  ok(d(balAfterCash.balance_minor, balBeforeCash.balance_minor) === 45000, "₹500 cash credited (₹450 to spend, ₹50 auto-saved)");

  // 5. my_record
  log("\n5. my_record");
  const mr = await voice("my_record");
  log(`  agent hears: "${mr.text}"`);
  ok(mr.record_url?.includes(CONTRACT), "links to the contract on Stellar Expert");

  // 6. Outbox -> chain
  log("\n6. Waiting for chain_outbox (chain-worker) ...");
  const deadline = Date.now() + 8 * 60_000;
  let rows: any[] = [];
  let lastKick = 0;
  let lastLine = "";
  for (;;) {
    const { data } = await admin.from("chain_outbox").select("*").gte("created_at", started.toISOString()).order("id");
    rows = data ?? [];
    const open = rows.filter((r) => r.status !== "done");
    const line = `  ${rows.length - open.length}/${rows.length} on-chain${open.length ? ` (${open.map((r) => r.status).join(", ")})` : ""}`;
    if (line !== lastLine) log(`${line}  +${((Date.now() - started.getTime()) / 1000).toFixed(0)} s`);
    lastLine = line;
    if (rows.length > 0 && open.length === 0) break;
    if (Date.now() > deadline) throw new Error(`outbox not drained: ${JSON.stringify(open.map((r) => [r.ref, r.status, r.last_error]))}`);
    if (Date.now() - lastKick > 20_000) {
      lastKick = Date.now();
      fetch(`${FN}/chain-worker`, { method: "POST", headers: { "x-plus-secret": SECRET }, body: "{}" }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  log("");
  const expected = 5; // received+saved (state transfer), paid, received+saved (cash)
  ok(rows.length === expected, `${rows.length} outbox rows done, all on-chain`);

  // Verify each contract event on-chain.
  const server = new stellarRpc.Server(RPC_URL);
  const timings: string[] = [];
  for (const r of rows) {
    const tx = await server.getTransaction(r.tx_hash);
    if (tx.status !== "SUCCESS") throw new Error(`tx ${r.tx_hash} is ${tx.status}`);
    const evs = await server.getEvents({ startLedger: tx.ledger, filters: [{ type: "contract", contractIds: [CONTRACT] }], limit: 50 });
    const ev = evs.events.find((e) => e.txHash === r.tx_hash);
    if (!ev) throw new Error(`no contract event for ${r.tx_hash}`);
    const topics = ev.topic.map((t) => scValToNative(t));
    const data = scValToNative(ev.value) as Record<string, unknown>;
    const hex = (b: unknown) => Buffer.from(b as Uint8Array).toString("hex");
    if (r.kind === "attest") {
      const kinds: Record<string, number> = { received: 0, saved: 1, paid: 2 };
      ok(topics[0] === "attested" && hex(topics[1]) === r.args.user_ref && Number(data.kind) === kinds[r.args.kind] &&
        String(data.amount) === r.args.amount && hex(data.payment_ref) === r.args.payment_ref,
        `on-chain attested(${r.args.kind}, ₹${Number(BigInt(r.args.amount) / 10_000_000n)}) ledger ${tx.ledger} ${r.tx_hash.slice(0, 10)}…`);
    } else {
      ok(topics[0] === "contribution_recorded" && Number(topics[1]) === Number(r.args.group_id) && hex(topics[2]) === r.args.member_ref &&
        String(data.amount) === r.args.amount,
        `on-chain contribution_recorded(group ${r.args.group_id}, ₹${Number(BigInt(r.args.amount) / 10_000_000n)}) ledger ${tx.ledger} ${r.tx_hash.slice(0, 10)}…`);
    }
    const closed = new Date(Number(tx.createdAt) * 1000);
    const confirmedAt = r.ref.includes(String(pp.action_id)) ? payConfirmAt
      : r.ref.includes(rec.cash_event.id) ? cashConfirmAt
      : null;
    if (confirmedAt) timings.push(`${r.kind}${r.args.kind ? `:${r.args.kind}` : ""}  ${((closed.getTime() - confirmedAt.getTime()) / 1000).toFixed(1)} s`);
  }
  const { data: payTx } = await selvi.client.from("transactions").select("chain_tx_hash").eq("id", pc.result.transaction_id).single();
  ok(payTx?.chain_tx_hash, "the app sees the payment as verified on Stellar (transactions.chain_tx_hash)");

  log("\nConfirm in Plus -> attest in a closed ledger (testnet):");
  for (const t of timings) log(`  ${t}`);
  log(`\nAll e2e checks passed (run ${RUN}).`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
