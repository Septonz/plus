// pnpm e2e:loan: the lending flow end to end on Stellar testnet, through the real Edge Functions.
// TESTNET and the dev project only.
//
//   1. A test person signs up (test number +2347000000302; each run archives the previous one), then
//      gets a compressed 8-week history and an independently verified stall stock (service role,
//      like the demo reset).
//   2. loan_status shows the offer: receive ₦30,000, cost ₦1,800, total ₦31,800.
//   3. prepare_loan, then confirm_action: refused without the PIN, accepted with it; the loan arrives
//      from the partner lender's account (lending_ng) on Stellar.
//   4. ₦5,000 arrives by bank transfer: 10% (₦500) goes to the loan on Stellar by itself.
//   5. "Repay now" ₦2,000 (under ₦5,000: a tapped Yes is enough).
//   6. "I need more time": the next payment moves two weeks; new borrowing pauses.
//   7. A second loan is refused while this one is open.
//   8. plus_credit (piece 8): the agreement, both repayments and the pledged stall stock are on the
//      contract, with only 32-byte references; "Repay all" closes it there as Repaid and frees the
//      stall stock. Read back from Stellar (needs the stellar CLI and its `admin` identity).
import { execFileSync } from "node:child_process";
import { plusFetch, signUp, testNin, testPin } from "./lib/onboard.ts";
import { adminClient, loadLocalEnv } from "./lib/supabase-admin.ts";

loadLocalEnv();
const { db, url } = adminClient();
const anon = process.env.VITE_SUPABASE_ANON_KEY!;
const PHONE = "+2347000000302";
const EXPERT = "https://stellar.expert/explorer/testnet/tx";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = plusFetch(url);
let failures = 0;
function check(ok: boolean, what: string, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${what}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

async function landed(txId: string, label: string) {
  const t0 = Date.now();
  for (;;) {
    const { data } = await db.from("transactions").select("status, chain_tx_hash").eq("id", txId).single();
    if (data?.status === "completed") return check(true, label, `${((Date.now() - t0) / 1000).toFixed(1)} s  ${EXPERT}/${data.chain_tx_hash}`);
    if (data?.status === "failed" || Date.now() - t0 > 90_000) return check(false, label, `status ${data?.status}`);
    await sleep(1000);
  }
}

/** Wait until every plus_credit write for this loan is done on Stellar. */
async function creditSettled(loanId: string) {
  const t0 = Date.now();
  for (;;) {
    const { data } = await db.from("chain_outbox").select("status").eq("args->>loan_id", loanId);
    const left = (data ?? []).filter((r) => r.status !== "done");
    if (data?.length && left.length === 0) return;
    if (Date.now() - t0 > 120_000) throw new Error(`plus_credit writes not done: ${left.map((r) => r.status).join(", ")}`);
    await sleep(2000);
  }
}

/** A read-only call to plus_credit (simulated, nothing is sent). */
function credit(fn: string, ...args: string[]): Record<string, unknown> {
  const id = process.env.PLUS_CREDIT_CONTRACT_ID;
  if (!id) throw new Error("PLUS_CREDIT_CONTRACT_ID is not set (.env.local)");
  const out = execFileSync("stellar", ["contract", "invoke", "--id", id, "--network", "testnet", "--source-account", "admin", "--send=no", "--", fn, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.trim().split("\n").pop()!);
}

async function main() {
  if ((process.env.STELLAR_NETWORK ?? "testnet") !== "testnet") throw new Error("testnet only");
  const pin = testPin();
  console.log("1. Sign-up and an 8-week history");
  const u = await signUp(url, anon, { name: "Loan Test", language: "en", phone: PHONE, pin, nin: testNin() });
  const me = (await db.from("users").select("id").eq("wa_phone", PHONE).is("archived_at", null).single()).data as { id: string };
  await db.from("users").update({ member_since: new Date(Date.now() - 8 * 7 * 86_400_000).toISOString() }).eq("id", me.id);
  await db.from("credit_history_seed").insert(Array.from({ length: 9 }, (_, i) => ({ user_id: me.id, week_index: i + 1, money_in: "1250000", qualifying_tx: 6, saved: "100000" })));
  await db.from("assets").insert({ user_id: me.id, type: "stock", description: "Stall stock (tomatoes)", estimated_value: "9000000", level: "independently_verified", status: "active", confidence: 85 });
  const tool = (name: string, body: Record<string, unknown> = {}) => call(`agent-tools/${name}`, body, u.accessToken);

  console.log("2. The offer");
  const s = await tool("loan_status");
  const offer = s.offer as Record<string, string> | undefined;
  check(s.view === "offer" && offer?.amount_text === "₦30,000" && offer?.cost_text === "₦1,800" && offer?.total_text === "₦31,800",
    "you receive ₦30,000, cost ₦1,800, total ₦31,800", String(s.view));

  console.log("3. Accept with the PIN");
  const p = await tool("prepare_loan");
  check(p.ok === true && typeof p.action_id === "string", "prepare_loan", String(p.text).slice(0, 80));
  const noPin = await tool("confirm_action", { action_id: p.action_id });
  check(noPin.error === "pin_required", "refused without the PIN", String(noPin.error));
  const yes = await tool("confirm_action", { action_id: p.action_id, pin });
  check(yes.status === "done" && typeof yes.transaction_id === "string", "accepted with the PIN");
  if (typeof yes.transaction_id === "string") await landed(yes.transaction_id, "₦30,000 from lending_ng on Stellar");
  const again = await tool("confirm_action", { action_id: p.action_id, pin });
  check(again.transaction_id === yes.transaction_id, "confirming twice returns the same result (idempotent)");

  console.log("4. Money in: 10% to the loan by itself");
  const ref = `e2e_loan_${Date.now()}`;
  const bank = (await db.rpc("ng_bank_transfer_in", { p_user_id: me.id, p_amount: 500_000, p_repay: 0, p_ref: ref, p_sender: "A customer" })).data as Record<string, string>;
  check(Boolean(bank?.loan_repay_transaction_id), "₦5,000 bank transfer queued a loan repayment");
  if (bank?.transaction_id) await landed(bank.transaction_id, "₦5,000 into her wallet");
  if (bank?.loan_repay_transaction_id) await landed(bank.loan_repay_transaction_id, "₦500 (10%) to the loan");

  console.log("5. Repay now ₦2,000");
  const r = await tool("prepare_loan_repay", { amount: 2000 });
  const ry = await tool("confirm_action", { action_id: r.action_id });
  check(ry.status === "done", "a tapped Yes is enough under ₦5,000");
  if (typeof ry.transaction_id === "string") await landed(ry.transaction_id, "₦2,000 to the loan");
  const after = await tool("loan_status");
  const loan = after.loan as Record<string, string> | undefined;
  check(after.view === "repay" && loan?.outstanding_text === "₦29,300", "₦29,300 left (31,800 - 500 - 2,000)", loan?.outstanding_text);

  console.log("6. I need more time");
  const m = await tool("loan_more_time");
  const my = await tool("confirm_action", { action_id: m.action_id });
  check(my.status === "done", "more time confirmed");
  const l = (await db.from("loans").select("next_due_at, borrowing_paused, extended_once").eq("user_id", me.id).eq("status", "active").single()).data as Record<string, unknown>;
  check(l?.borrowing_paused === true && l?.extended_once === true, "next payment moved; new borrowing paused", String(l?.next_due_at));

  console.log("7. One loan at a time");
  const second = await tool("prepare_loan");
  check(second.error === "loan_open", "a second loan is refused", String(second.error));

  console.log("8. On plus_credit (read from Stellar)");
  const open = (await db.from("loans").select("id").eq("user_id", me.id).eq("status", "active").single()).data as { id: string };
  await creditSettled(open.id);
  const rows = (await db.from("chain_outbox").select("ref, args").eq("args->>loan_id", open.id).order("id")).data as { ref: string; args: { fn: string; args: { v: unknown }[] } }[];
  const opened = rows.find((r) => r.args.fn === "loan_open");
  const loanRef = String(opened?.args.args[1].v);
  const assetRef = String(opened?.args.args[8].v);
  const blob = JSON.stringify(rows.map((r) => r.args));
  check(!/Loan Test|tomato|2347000000302/i.test(blob) && rows.every((r) => r.args.args.every((a) => /^([0-9a-f]{64}|G[A-Z2-7]{55}|-?\d+|null)$/.test(String(a.v)))),
    "only references, addresses and amounts go on-chain (no name, phone or description)");
  let onChain = credit("loan", "--loan", loanRef);
  check(onChain.status === 0 && onChain.repaid === String(2_500n * 10_000_000n) && onChain.total === String(31_800n * 10_000_000n) && onChain.collateral === assetRef,
    "the agreement: Active, ₦2,500 repaid of ₦31,800, the stall stock as collateral", `${rows.length} writes`);
  check(credit("asset", "--asset", assetRef).pledged_to === loanRef, "the stall stock is pledged to it");
  const all = await tool("prepare_loan_repay", {});
  const ay = await tool("confirm_action", { action_id: all.action_id, pin });
  if (typeof ay.transaction_id === "string") await landed(ay.transaction_id, "Repay all: ₦29,300");
  await creditSettled(open.id);
  onChain = credit("loan", "--loan", loanRef);
  check(onChain.status === 3 && onChain.repaid === onChain.total, "Repaid on plus_credit (by the repayments themselves)");
  check(credit("asset", "--asset", assetRef).pledged_to === null, "the stall stock is free again");

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`e2e:loan failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
