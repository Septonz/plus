// pnpm e2e:guest: the public test link's 6 steps as a brand-new visitor, timed (piece 12).
// TESTNET and the dev project only. The same agent-tools calls the screens make on each tap.
//
//   0. Try Plus now: agent-tools/guest_start with a fresh device id, then the one-time sign-in.
//   1. Balance and activity.   2. Pay Mama Put Canteen by its pay code.   3. Save ₦1,000.
//   4. The loan offer, accepted with PIN 1234.   5. Share the record; /verify opens it.
//   6. A cash-out code, then "Pretend an agent paid this out".
// Each money step waits for its "Verified on Stellar" tick (the transaction completed on Stellar),
// and the guest checklist must tick all 6. A guest place is used; the scheduler resets it after
// 30 idle minutes (or: pnpm guests:reset <slot>).
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { plusFetch } from "./lib/onboard.ts";
import { adminClient, loadLocalEnv } from "./lib/supabase-admin.ts";

loadLocalEnv();
const { db, url } = adminClient();
const anonKey = process.env.VITE_SUPABASE_ANON_KEY!;
const call = plusFetch(url);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const timings: [string, number][] = [];
function check(ok: boolean, what: string, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${what}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Seconds until the transaction row is completed on Stellar (null: failed or not within 90 s). */
async function tick(txId: unknown): Promise<number | null> {
  if (typeof txId !== "string") return null;
  const t0 = Date.now();
  for (;;) {
    const { data } = await db.from("transactions").select("status").eq("id", txId).single();
    if (data?.status === "completed") return (Date.now() - t0) / 1000;
    if (data?.status === "failed" || Date.now() - t0 > 90_000) return null;
    await sleep(500);
  }
}

async function main() {
  if ((process.env.STELLAR_NETWORK ?? "testnet") !== "testnet") throw new Error("testnet only");
  const run0 = Date.now();
  console.log("0. Try Plus now");
  const t0 = Date.now();
  const g = await call("agent-tools/guest_start", { kind: "trader", device_id: randomBytes(16).toString("hex") });
  check(g.ok === true && typeof g.sign_in_token === "string", "a guest of her own", `${g.name ?? g.error} ${g.busy ? "(busy)" : ""}${g.fresh ? " (reset first)" : ""}`);
  if (!g.ok) throw new Error(String(g.text ?? g.error));
  const sb = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data: s, error } = await sb.auth.verifyOtp({ token_hash: g.sign_in_token, type: "magiclink" });
  if (error || !s.session) throw new Error(`sign-in: ${error?.message}`);
  const token = s.session.access_token;
  const tool = (name: string, body: Record<string, unknown> = {}) => call(`agent-tools/${name}`, body, token);
  timings.push(["Try Plus now → signed in", Date.now() - t0]);
  const me = await tool("get_user");
  check(me.guest === true && g.test_pin === "1234", "a guest, test PIN 1234", String(me.name));

  console.log("1. Balance and activity");
  let t = Date.now();
  const [bal, rec] = await Promise.all([tool("get_balance"), tool("my_record")]);
  await tool("guest_status", { seen: "activity" });
  timings.push(["Balance + activity", Date.now() - t]);
  const recent = (rec.recent ?? []) as { label: string }[];
  check(/₦|naira/.test(String(bal.text)) && recent.length >= 5, "her wallet and her history", `${String(bal.text).slice(0, 60)} · ${recent.length} rows`);

  console.log("2. Pay Mama Put Canteen");
  const toFunmi = await tool("prepare_pay", { phone: "+2340000000501", amount: 100 });
  check(toFunmi.error === "protected_account", "paying a presenter (Funmi) is refused", String(toFunmi.text).slice(0, 60));
  const st = await tool("guest_status");
  const shop = String(st.shop_code ?? "");
  check(/^[A-Z0-9]{6}$/.test(shop), "the test shop's pay code under Scan", `${shop.slice(0, 3)}-${shop.slice(3)}`);
  t = Date.now();
  const pay = await tool("prepare_pay", { code: shop, amount: 500 });
  check(pay.ok !== false && typeof pay.action_id === "string", "prepare ₦500 to Mama Put Canteen", String(pay.text).slice(0, 60));
  const paid = await tool("confirm_action", { action_id: pay.action_id });
  const payTick = await tick(paid.transaction_id);
  timings.push(["Pay a shop: Yes → tick", Date.now() - t]);
  check(paid.status === "done" && payTick !== null, "paid on Stellar", payTick !== null ? `${payTick.toFixed(1)} s to the tick` : String(paid.text));

  console.log("3. Save ₦1,000");
  t = Date.now();
  const save = await tool("prepare_save", { amount: 1000 });
  const saved = await tool("confirm_action", { action_id: save.action_id });
  const saveTick = await tick(saved.transaction_id);
  timings.push(["Save ₦1,000: Yes → tick", Date.now() - t]);
  check(saved.status === "done" && saveTick !== null, "saved into her pot on Stellar", saveTick !== null ? `${saveTick.toFixed(1)} s` : String(saved.text));

  console.log("4. The loan offer");
  t = Date.now();
  const offer = await tool("loan_status");
  const amount = (offer.offer as Record<string, string> | undefined)?.amount_text;
  check(offer.view === "offer" && amount === "₦30,000", "a ₦30,000 offer", String(offer.view));
  const loan = await tool("prepare_loan");
  check((await tool("confirm_action", { action_id: loan.action_id, pin: "0000" })).error === "pin_wrong", "a wrong PIN is refused");
  const took = await tool("confirm_action", { action_id: loan.action_id, pin: "1234" });
  const loanTick = await tick(took.transaction_id);
  timings.push(["Loan: open → PIN → tick", Date.now() - t]);
  check(took.status === "done" && loanTick !== null, "accepted with PIN 1234, on Stellar", loanTick !== null ? `${loanTick.toFixed(1)} s` : String(took.text));

  console.log("5. Share the record, open it on /verify");
  t = Date.now();
  const share = await tool("share_record");
  const yes = await tool("confirm_action", { action_id: share.action_id, pin: "1234" });
  const code = String(yes.share_code ?? "");
  const lender = createClient(url, anonKey, { auth: { persistSession: false } });
  const v = (await lender.rpc("verify_record", { p_code: code })).data as Record<string, unknown> | null;
  timings.push(["Share → /verify opens it", Date.now() - t]);
  check(v?.ok === true, "/verify opens her code", code ? `${code.slice(0, 2)}••-••••` : String(yes.text));

  console.log("6. Cash out");
  t = Date.now();
  const co = await tool("prepare_cashout", { amount: 2000 });
  const coYes = await tool("confirm_action", { action_id: co.action_id });
  check(coYes.status === "done" && /^\d{6}$/.test(String(coYes.cash_out_code ?? "")), "a 6-digit code on her screen", "••••••");
  let out: Record<string, unknown> = {};
  for (let i = 0; i < 30; i++) {
    out = await tool("guest_agent_paid");
    if (out.error !== "not_ready") break;
    await sleep(1000);
  }
  timings.push(["Cash-out code → paid out", Date.now() - t]);
  check(out.ok === true, "the demo agent paid it out", String(out.text).slice(0, 70));

  console.log("Checklist");
  await sleep(1500);
  const done = ((await tool("guest_status")).steps ?? []) as { key: string; done: boolean }[];
  check(done.length === 6 && done.every((x) => x.done), "all 6 steps ticked", done.map((x) => `${x.key}${x.done ? "✓" : "·"}`).join(" "));

  console.log("\nTimings:");
  for (const [k, ms] of timings) console.log(`  ${k.padEnd(28)} ${(ms / 1000).toFixed(1)} s`);
  console.log(`  ${"All 6 steps".padEnd(28)} ${((Date.now() - run0) / 1000).toFixed(1)} s`);
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`e2e:guest failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
