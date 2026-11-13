// pnpm e2e:vouch: vouches end to end (piece 10; piece 13 rule). TESTNET and the dev project only.
//
//   1. A test person (+2347000000305; each run archives the previous one) with a compressed history
//      and a verified stall stock. A bank transfer comes in, and she pays Amaka and Tunde ₦100 three
//      times each on Stellar: under the piece 13 rule, anyone in good standing (verified ID, 6+ weeks,
//      no missed loan payments) can vouch for someone they have paid or been paid by 3+ times.
//      Her offer needs 150% collateral. (She is marked a demo account for the run, so she may pay
//      the demo people; the mark goes with her when the next run archives her.)
//   2. Amaka vouches, withdraws, vouches again; Tunde vouches. Each one is written to plus_credit.
//      Her offer now explains: 100% instead of 150%. Someone not in good standing is refused.
//   3. She takes the loan with her PIN: on plus_credit the loan carries both vouchers, needs 100%,
//      and her waiting vouches are cleared.
//   4. The loan defaults: Amaka and Tunde lose vouching rights for 6 months (Vouched loan defaulted
//      on Stellar); no money moves from them.
//   Then Amaka's and Tunde's demo state is put back (bans cleared, Tunde's vouch for Funmi again).
import { execFileSync } from "node:child_process";
import { plusFetch, signUp, testNin, testPin } from "./lib/onboard.ts";
import { adminClient, loadLocalEnv } from "./lib/supabase-admin.ts";

loadLocalEnv();
const { db, url } = adminClient();
const anonKey = process.env.VITE_SUPABASE_ANON_KEY!;
const PHONE = "+2347000000305";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => Promise<boolean>, what: string, ms = 120_000) {
  const t0 = Date.now();
  while (!(await ok())) {
    if (Date.now() - t0 > ms) throw new Error(`${what}: not done after ${ms / 1000} s`);
    await sleep(1500);
  }
}
const call = plusFetch(url);
let failures = 0;
function check(ok: boolean, what: string, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${what}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}
function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

/** Every plus_credit row with one of these ids in its args is done on Stellar. */
async function settled(ids: string[]) {
  const t0 = Date.now();
  for (;;) {
    const { data } = await db.from("chain_outbox").select("status, args").eq("args->>contract", "credit");
    const mine = (data ?? []).filter((r) => {
      const a = r.args as Record<string, unknown>;
      return ids.includes(String(a.loan_id ?? a.asset_id ?? a.vouch_id));
    });
    if (mine.some((r) => r.status === "failed")) throw new Error("a plus_credit write failed");
    if (mine.length && mine.every((r) => r.status === "done")) return mine.length;
    if (Date.now() - t0 > 240_000) throw new Error("plus_credit writes not done after 4 minutes");
    await sleep(2000);
  }
}

function credit(fn: string, ...args: string[]): unknown {
  const id = process.env.PLUS_CREDIT_CONTRACT_ID;
  if (!id) throw new Error("PLUS_CREDIT_CONTRACT_ID is not set (.env.local)");
  const out = execFileSync("stellar", ["contract", "invoke", "--id", id, "--network", "testnet", "--source-account", "admin", "--send=no", "--", fn, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.trim().split("\n").pop()!);
}
const ref = async (userId: string) => must(await db.rpc("credit_borrower_ref", { p_user_id: userId }), "ref") as string;

async function main() {
  if ((process.env.STELLAR_NETWORK ?? "testnet") !== "testnet") throw new Error("testnet only");
  const pin = testPin();
  const amaka = must(await db.from("users").select("id").eq("name", "Amaka").eq("market_id", "ng").is("archived_at", null).single(), "Amaka") as { id: string };
  const tunde = must(await db.from("users").select("id").eq("name", "Tunde").eq("market_id", "ng").is("archived_at", null).maybeSingle(), "Tunde") as { id: string } | null;
  const funmi = must(await db.from("users").select("id").eq("name", "Funmi").eq("market_id", "ng").is("archived_at", null).single(), "Funmi") as { id: string };
  if (!tunde) throw new Error("Tunde is not a Plus user yet: run pnpm demo:reset ng first");

  console.log("1. A borrower who has paid Amaka and Tunde 3 times each");
  const u = await signUp(url, anonKey, { name: "Vouch Test", language: "en", phone: PHONE, pin, nin: testNin() });
  const me = (await db.from("users").select("id").eq("wa_phone", PHONE).is("archived_at", null).single()).data as { id: string };
  await db.from("users").update({ member_since: new Date(Date.now() - 8 * 7 * 86_400_000).toISOString() }).eq("id", me.id);
  await db.from("credit_history_seed").insert(Array.from({ length: 9 }, (_, i) => ({ user_id: me.id, week_index: i + 1, money_in: "1250000", qualifying_tx: 6, savings: "100000" })));
  const stock = must(await db.from("assets").insert({ user_id: me.id, type: "stock", description: "Stall stock (peppers)", estimated_value: "9000000", level: "independently_verified", status: "active", confidence: 85 }).select("id").single(), "stock") as { id: string };
  const tool = (name: string, body: Record<string, unknown> = {}) => call(`agent-tools/${name}`, body, u.accessToken);
  must(await db.from("users").update({ demo_login: true }).eq("id", me.id), "demo mark");
  must(await db.rpc("ng_bank_transfer_in", { p_user_id: me.id, p_amount: 500_000, p_repay: 0, p_ref: `e2e_vouch_${Date.now()}`, p_sender: "A customer" }), "money in");
  await until(async () => ((await db.from("transactions").select("status").eq("user_id", me.id).eq("kind", "incoming")).data ?? []).some((t) => t.status === "completed"), "her ₦5,000 in");
  const phones = must(await db.from("users").select("id, wa_phone").in("id", [amaka.id, tunde.id]), "phones") as { id: string; wa_phone: string }[];
  for (const p of phones) {
    for (let i = 0; i < 3; i++) {
      const prep = await tool("prepare_pay", { phone: p.wa_phone, amount: "100" });
      if (!prep.action_id) throw new Error(`prepare_pay: ${String(prep.text)}`);
      const yes = await tool("confirm_action", { action_id: prep.action_id, pin });
      await until(async () => (await db.from("transactions").select("status").eq("id", String(yes.transaction_id)).single()).data?.status === "completed", "payment on Stellar");
    }
  }
  const t = must(await db.rpc("vouch_check", { p_voucher: amaka.id, p_borrower: me.id }), "check") as { ok: boolean; trades?: number; reason?: string };
  check(t.ok && t.trades === 3, "Amaka may vouch: 3 payments between them on Stellar", String(t.trades ?? t.reason));
  const before = await tool("loan_status");
  check((before.offer as Record<string, unknown>)?.collateral_pct === 150, "her first offer needs 150% collateral", String((before.offer as Record<string, unknown>)?.amount_text));

  console.log("2. Amaka and Tunde vouch (written to plus_credit)");
  const v1 = must(await db.rpc("vouch_record", { p_voucher: amaka.id, p_borrower: me.id }), "Amaka vouches") as string;
  check(must(await db.rpc("vouch_withdraw", { p_voucher: amaka.id, p_vouch_id: v1 }), "withdraw") === true, "Amaka withdraws her vouch (before any loan)");
  const v2 = must(await db.rpc("vouch_record", { p_voucher: amaka.id, p_borrower: me.id }), "Amaka again") as string;
  const v3 = must(await db.rpc("vouch_record", { p_voucher: tunde.id, p_borrower: me.id }), "Tunde vouches") as string;
  const dup = await db.rpc("vouch_record", { p_voucher: amaka.id, p_borrower: me.id });
  check(/vouch_already/.test(dup.error?.message ?? ""), "a second vouch from Amaka is refused");
  const self = (await db.rpc("vouch_check", { p_voucher: me.id, p_borrower: amaka.id })).data as { ok: boolean; reason: string };
  void self;
  const stranger = (await db.rpc("vouch_check", { p_voucher: me.id, p_borrower: funmi.id })).data as { ok: boolean; reason: string; trades: number };
  check(!stranger.ok && stranger.reason === "few_trades", "she can't vouch for Funmi: they have never paid each other", `${stranger.reason}, ${stranger.trades}`);
  await settled([v1, v2, v3]);
  const myRef = await ref(me.id);
  const waiting = credit("vouches_for", "--borrower", myRef) as string[];
  check(waiting.length === 2 && waiting.includes(await ref(amaka.id)) && waiting.includes(await ref(tunde.id)), "plus_credit: two vouches waiting for her next loan (Amaka's withdrawn one is gone)");
  const offer = await tool("loan_status");
  check((offer.offer as Record<string, unknown>)?.collateral_pct === 100 && /Amaka and Tunde vouched for this loan .*100% collateral instead of 150%/.test(String(offer.text)),
    "her offer: 100% collateral instead of 150%, and why", String(offer.text).match(/Amaka and Tunde[^.]*\./)?.[0] ?? "");

  console.log("3. She takes the loan (her PIN)");
  const p = await tool("prepare_loan");
  const took = await tool("confirm_action", { action_id: p.action_id, pin });
  check(took.status === "done", "loan accepted", String(took.text));
  const loan = must(await db.from("loans").select("id, collateral_pct").eq("user_id", me.id).single(), "loan") as { id: string; collateral_pct: number };
  const used = must(await db.from("vouches").select("status, loan_id").in("id", [v2, v3]), "used") as { status: string; loan_id: string }[];
  check(loan.collateral_pct === 100 && used.every((v) => v.status === "used" && v.loan_id === loan.id), "the loan needs 100%; both vouches are on it");
  await settled([loan.id, stock.id]);
  const loanRef = (credit("loans_of", "--borrower", myRef) as string[])[0];
  const onChain = credit("loan", "--loan", loanRef) as Record<string, unknown>;
  check((onChain.vouchers as string[]).length === 2 && onChain.collateral_pct === 100 && (credit("vouches_for", "--borrower", myRef) as string[]).length === 0,
    "plus_credit: the loan carries both vouchers at 100%; nothing left waiting");
  const status = await tool("loan_status");
  check(((status.loan as Record<string, unknown>)?.vouched_by as string[] | undefined)?.join(",") === "Amaka,Tunde", "her loan screen: vouched for by Amaka and Tunde");

  console.log("4. The loan defaults");
  const { count: txBefore } = await db.from("transactions").select("id", { count: "exact", head: true }).in("user_id", [amaka.id, tunde.id]);
  must(await db.from("loans").update({ status: "default" }).eq("id", loan.id), "default");
  const banned = must(await db.from("users").select("id, vouch_banned_until").in("id", [amaka.id, tunde.id]), "bans") as { vouch_banned_until: string | null }[];
  const months = (iso: string | null) => iso ? (new Date(iso).getTime() - Date.now()) / (30.4 * 86_400_000) : 0;
  check(banned.every((b) => months(b.vouch_banned_until) > 5.9 && months(b.vouch_banned_until) < 6.1), "Amaka and Tunde can't vouch for 6 months");
  const c = (await db.rpc("vouch_check", { p_voucher: amaka.id, p_borrower: funmi.id })).data as { ok: boolean; reason: string };
  check(!c.ok && c.reason === "banned", "Amaka can't vouch for Funmi now", c.reason);
  const { count: txAfter } = await db.from("transactions").select("id", { count: "exact", head: true }).in("user_id", [amaka.id, tunde.id]);
  check(txBefore === txAfter, "no money taken from them (no new transactions)");
  const vs = must(await db.from("vouches").select("status").in("id", [v2, v3]), "defaulted") as { status: string }[];
  check(vs.every((v) => v.status === "defaulted"), "their vouches are marked defaulted");
  await settled([loan.id]);
  const after = credit("loan", "--loan", loanRef) as Record<string, unknown>;
  check(after.status === 4, "plus_credit: the loan is Default (one Vouched loan defaulted event per voucher)");

  console.log("5. Amaka's and Tunde's demo state back");
  must(await db.from("loans").update({ closed_by_reset: true }).eq("id", loan.id), "close test loan");
  must(await db.from("users").update({ vouch_banned_until: null }).in("id", [amaka.id, tunde.id]), "clear bans");
  const { data: tv } = await db.from("vouches").select("id").eq("voucher_user_id", tunde.id).eq("borrower_user_id", funmi.id).eq("status", "active");
  if (!tv?.length) {
    const { error } = await db.rpc("vouch_record", { p_voucher: tunde.id, p_borrower: funmi.id });
    if (error) console.log(`  (Tunde's vouch for Funmi: ${error.message}; pnpm demo:reset ng puts it back)`);
  }
  const back = (await db.rpc("vouch_check", { p_voucher: amaka.id, p_borrower: funmi.id })).data as { ok: boolean };
  check(back.ok, "Amaka can vouch for Funmi again; Tunde's vouch for Funmi is waiting");

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`e2e:vouch failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
