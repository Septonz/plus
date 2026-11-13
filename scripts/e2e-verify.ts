// pnpm e2e:verify: share a Plus record with a lender and verify it from Stellar (piece 9).
// TESTNET and the dev project only.
//
//   1. A test person (+2347000000304; each run archives the previous one) with a compressed history
//      and an independently verified stall stock takes a ₦30,000 loan and repays ₦2,000, so her
//      plus_credit record has an asset, a loan and a repayment on Stellar.
//   2. share_record: the consent read back; refused without the PIN; with it, a one-time code.
//      Only a keyed hash is stored, never the code.
//   3. /verify's lookup (anon, no login): the code gives her plus_credit reference and wallet, and
//      plus_credit on Stellar answers for that reference: one loan, ₦2,000 repaid, the stall stock.
//      A wrong code is refused; every attempt is logged.
//   4. She revokes it: the code stops working.
//   --keep: then prints one more open code, to try the /verify page by hand.
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { plusFetch, signUp, testNin, testPin } from "./lib/onboard.ts";
import { adminClient, loadLocalEnv } from "./lib/supabase-admin.ts";

loadLocalEnv();
const { db, url } = adminClient();
const anonKey = process.env.VITE_SUPABASE_ANON_KEY!;
const PHONE = "+2347000000304";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = plusFetch(url);
let failures = 0;
function check(ok: boolean, what: string, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${what}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

async function landed(txId: string) {
  const t0 = Date.now();
  for (;;) {
    const { data } = await db.from("transactions").select("status").eq("id", txId).single();
    if (data?.status === "completed") return true;
    if (data?.status === "failed" || Date.now() - t0 > 90_000) return false;
    await sleep(1000);
  }
}

/** Every plus_credit write for this person is done on Stellar. */
async function creditSettled(userId: string) {
  const t0 = Date.now();
  const { data: loans } = await db.from("loans").select("id").eq("user_id", userId);
  const { data: assets } = await db.from("assets").select("id").eq("user_id", userId);
  const ids = [...(loans ?? []), ...(assets ?? [])].map((r) => r.id as string);
  for (;;) {
    const { data } = await db.from("chain_outbox").select("status, args").eq("args->>contract", "credit");
    const mine = (data ?? []).filter((r) => ids.includes(String((r.args as Record<string, unknown>).loan_id ?? (r.args as Record<string, unknown>).asset_id)));
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

async function main() {
  if ((process.env.STELLAR_NETWORK ?? "testnet") !== "testnet") throw new Error("testnet only");
  const pin = testPin();

  console.log("1. A record on Stellar: an asset, a loan, a repayment");
  const u = await signUp(url, anonKey, { name: "Verify Test", language: "en", phone: PHONE, pin, nin: testNin() });
  const me = (await db.from("users").select("id").eq("wa_phone", PHONE).is("archived_at", null).single()).data as { id: string };
  await db.from("users").update({ member_since: new Date(Date.now() - 8 * 7 * 86_400_000).toISOString() }).eq("id", me.id);
  await db.from("credit_history_seed").insert(Array.from({ length: 9 }, (_, i) => ({ user_id: me.id, week_index: i + 1, money_in: "1250000", qualifying_tx: 6, savings: "100000" })));
  await db.from("assets").insert({ user_id: me.id, type: "stock", description: "Stall stock (tomatoes)", estimated_value: "9000000", level: "independently_verified", status: "active", confidence: 85 });
  const tool = (name: string, body: Record<string, unknown> = {}) => call(`agent-tools/${name}`, body, u.accessToken);
  const loan = await tool("prepare_loan");
  const took = await tool("confirm_action", { action_id: loan.action_id, pin });
  check(took.status === "done" && await landed(String(took.transaction_id)), "₦30,000 loan on Stellar");
  const r = await tool("prepare_loan_repay", { amount: 2000 });
  const ry = await tool("confirm_action", { action_id: r.action_id });
  check(ry.status === "done" && await landed(String(ry.transaction_id)), "₦2,000 repaid on Stellar");
  check((await creditSettled(me.id)) >= 3, "plus_credit: asset, loan and repayment written");

  console.log("2. She shares it");
  const s = await tool("share_record");
  check(s.ok === true && s.requires_pin === true && /Never her name, phone number, ID, photos/.test(String(s.text)), "consent read back; her PIN needed", String(s.text).slice(0, 70));
  check((await tool("confirm_action", { action_id: s.action_id })).error === "pin_required", "refused without the PIN");
  const yes = await tool("confirm_action", { action_id: s.action_id, pin });
  const code = String(yes.share_code ?? "");
  check(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(code), "a one-time code on her screen", code.replace(/./g, "•"));
  const stored = JSON.stringify((await db.from("record_shares").select("*").eq("user_id", me.id)).data) +
    JSON.stringify((await db.from("pending_actions").select("params, result").eq("id", s.action_id).single()).data);
  check(!stored.includes(code.replace("-", "")), "the code itself is stored nowhere (only a keyed hash)");

  console.log("3. A lender verifies it on /verify (no login)");
  const lender = createClient(url, anonKey, { auth: { persistSession: false } });
  const t0 = Date.now();
  const v = (await lender.rpc("verify_record", { p_code: code.toLowerCase() })).data as Record<string, string>;
  check(v?.ok as unknown === true && /^[0-9a-f]{64}$/.test(v.borrower_ref) && /^G[A-Z2-7]{55}$/.test(v.wallet), "the code opens her record (her reference and wallet only)");
  check(!JSON.stringify(v).includes("Verify Test") && !JSON.stringify(v).includes("2347000000304"), "no name or phone in what the lender gets");
  const loans = credit("loans_of", "--borrower", v.borrower_ref) as string[];
  const onChain = credit("loan", "--loan", loans[0]) as Record<string, unknown>;
  const assets = credit("assets_of", "--owner", v.borrower_ref) as string[];
  const stall = credit("asset", "--asset", assets[0]) as Record<string, unknown>;
  check(loans.length === 1 && onChain.repaid === String(2_000n * 10_000_000n) && onChain.status === 0, "read from plus_credit: one loan, ₦2,000 repaid, Active");
  check(assets.length === 1 && stall.level === 3 && stall.pledged_to === loans[0], "read from plus_credit: the stall stock, independently verified, securing it", `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const again = (await lender.rpc("verify_record", { p_code: code })).data as Record<string, unknown>;
  check(again?.ok === true, "the same lender can open it again (refresh)");
  const wrong = (await lender.rpc("verify_record", { p_code: "AAAA-AAAA" })).data as Record<string, unknown>;
  check(wrong?.error === "not_found", "a wrong code is refused");
  const { data: share } = await db.from("record_shares").select("id, views").eq("user_id", me.id).single();
  const { count } = await db.from("record_verify_attempts").select("id", { count: "exact", head: true }).eq("share_id", share!.id);
  check(share?.views === 2 && count === 2, "every view is logged for her", `${share?.views} views`);
  const list = await tool("record_shares");
  check(((list.shares ?? []) as { status: string }[])[0]?.status === "used", "her list: opened by a lender", String(list.text).slice(0, 70));

  console.log("4. She revokes it");
  const rv = await tool("revoke_record_share", { share_id: share!.id });
  check(rv.ok === true, "revoked");
  const after = (await lender.rpc("verify_record", { p_code: code })).data as Record<string, unknown>;
  check(after?.error === "revoked", "the code no longer works");

  // --keep: one more code, left open, to try the /verify page by hand (a test person's code).
  if (process.argv.includes("--keep")) {
    const k = await tool("share_record");
    const ky = await tool("confirm_action", { action_id: k.action_id, pin });
    console.log(`\nOpen code for the /verify page (24 hours): ${String(ky.share_code)}`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`e2e:verify failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
