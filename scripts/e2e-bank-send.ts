// pnpm e2e:bank: send to a bank account end to end on Stellar testnet (piece 7), as Funmi.
// TESTNET and the dev project only; `pnpm demo:reset ng` puts her balance back afterwards.
//
//   1. bank_lookup: Ironwood Bank 0123456789 -> "ADEBAYO STORES"; a wrong number is refused.
//   2. prepare_bank_send ₦2,000 (under ₦5,000: her Yes is enough), then confirm_action.
//   3. Her NGNT goes to the partner's anchor (anchor_ng) on Stellar; the transaction completes and
//      shows as "sent to bank (partner, simulated)"; the anchor's withdrawal record has the account.
//   4. ₦8,000 needs her PIN (refused without it).
import { createClient } from "@supabase/supabase-js";
import { plusFetch } from "./lib/onboard.ts";
import { adminClient, loadLocalEnv } from "./lib/supabase-admin.ts";

loadLocalEnv();
const { db, url } = adminClient();
const call = plusFetch(url);
const EXPERT = "https://stellar.expert/explorer/testnet/tx";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(ok: boolean, what: string, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${what}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  if ((process.env.STELLAR_NETWORK ?? "testnet") !== "testnet") throw new Error("testnet only");
  const c = createClient(url, process.env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signInWithPassword({ email: "demo-funmi@example.com", password: process.env.VITE_DEMO_LOGIN_PASSWORD! });
  if (error) throw new Error(`Funmi's login: ${error.message}`);
  const tool = (name: string, body: Record<string, unknown> = {}) => call(`agent-tools/${name}`, body, data.session.access_token);

  console.log("1. The name enquiry (simulated)");
  const l = await tool("bank_lookup", { bank: "Ironwood Bank", account_number: "0123456789" });
  check(l.ok === true && l.account_name === "ADEBAYO STORES", "Ironwood Bank 0123456789: ADEBAYO STORES", String(l.text).slice(0, 70));
  const bad = await tool("bank_lookup", { bank: "Ironwood Bank", account_number: "9990000001" });
  check(bad.error === "account_not_found", "a number the bank doesn't know is refused");

  console.log("2. Send ₦2,000");
  const p = await tool("prepare_bank_send", { amount: "2000", bank: "D01", account_number: "0123456789" });
  check(p.ok === true && p.requires_pin === false, "prepared; her Yes is enough", String(p.readback ?? p.text).slice(0, 90));
  const t0 = Date.now();
  const y = await tool("confirm_action", { action_id: p.action_id });
  check(y.ok === true && typeof y.transaction_id === "string", "confirmed", String(y.text).slice(0, 90));
  const again = await tool("confirm_action", { action_id: p.action_id });
  check(again.transaction_id === y.transaction_id, "a retried Yes returns the same result (nothing sent twice)");

  console.log("3. On Stellar, to the partner's anchor");
  for (;;) {
    const { data: t } = await db.from("transactions").select("status, chain_tx_hash, source, counterparty").eq("id", y.transaction_id).single();
    if (t?.status === "completed") {
      check(t.source === "bank" && /ADEBAYO STORES, Ironwood Bank/.test(String(t.counterparty)), "completed", `${((Date.now() - t0) / 1000).toFixed(1)} s  ${EXPERT}/${t.chain_tx_hash}`);
      const { data: op } = await db.from("chain_outbox").select("args").eq("ref", `bank_send:${p.action_id}`).single();
      const { data: anchor } = await db.from("system_wallets").select("pub").eq("signer", "anchor_ng").single();
      check((op?.args as { to?: string })?.to === anchor?.pub, "paid to anchor_ng (the partner's anchor)");
      break;
    }
    if (t?.status === "failed" || Date.now() - t0 > 90_000) {
      check(false, "completed", `status ${t?.status}`);
      break;
    }
    await sleep(1000);
  }
  const { data: wd } = await db.from("bank_withdrawals").select("account_number, account_name, bank_name, amount").eq("action_id", p.action_id).single();
  check(wd?.account_number === "0123456789" && wd?.amount === 200000, "the anchor's withdrawal record: account, name and amount", `${wd?.account_name}, ${wd?.bank_name}`);
  const rec = await tool("my_record");
  const row = ((rec.recent ?? []) as { id: string; label: string }[]).find((r) => r.id === y.transaction_id);
  check(row?.label === "sent to bank (partner, simulated)", "her activity: sent to bank (partner, simulated)");

  console.log("4. Above ₦5,000: her PIN");
  const big = await tool("prepare_bank_send", { amount: "8000", bank: "D01", account_number: "0123456789" });
  check(big.requires_pin === true, "₦8,000 needs her PIN");
  const noPin = await tool("confirm_action", { action_id: big.action_id });
  check(noPin.error === "pin_required", "refused without it");
  await tool("reject_action", { action_id: big.action_id });

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
