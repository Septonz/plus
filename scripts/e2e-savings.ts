// pnpm e2e:savings: Funmi's savings goal end to end on Stellar Testnet (piece 11), through the same
// tools the app and the voice agent use:
//   1. savings_status: her goal pot is on the plus contract
//   2. prepare_save ₦1,000 -> confirm_action -> pot_fund confirmed on Stellar; the pot grows
//   3. a ₦2,000 bank transfer in -> auto-save (10% of what is left after any loan share) into the pot
//   4. prepare_withdraw_savings back to her wallet -> pot_send confirmed; the pot is where it started
// Run after `pnpm demo:reset ng` (goal "Stall shade", ₦18,500 saved, auto-save 10%).
import { createClient } from "@supabase/supabase-js";
import { adminClient, loadLocalEnv } from "./lib/supabase-admin.ts";

loadLocalEnv();
const { db, url } = adminClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Json = Record<string, unknown>;

function check(ok: unknown, what: string) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`  ✓ ${what}`);
}

async function login() {
  const c = createClient(url, process.env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signInWithPassword({ email: "demo-funmi@example.com", password: process.env.VITE_DEMO_LOGIN_PASSWORD! });
  if (error) throw new Error(`login: ${error.message}`);
  return async (tool: string, args: Json = {}) => {
    const r = await fetch(`${url}/functions/v1/agent-tools/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify(args),
    });
    return await r.json() as Json;
  };
}

async function kick() {
  await fetch(`${url}/functions/v1/chain-worker`, { method: "POST", headers: { "x-plus-secret": process.env.AGENT_SHARED_SECRET! } }).then((r) => r.body?.cancel(), () => {});
}

async function completed(id: string, what: string) {
  const t0 = Date.now();
  for (;;) {
    const { data } = await db.from("transactions").select("status, chain_tx_hash").eq("id", id).single();
    if (data?.status === "completed") return { secs: (Date.now() - t0) / 1000, hash: data.chain_tx_hash as string };
    if (data?.status === "failed") throw new Error(`${what}: failed on Stellar`);
    if (Date.now() - t0 > 90_000) throw new Error(`${what}: not on Stellar after 90 s`);
    if ((Date.now() - t0) % 10_000 < 500) await kick();
    await sleep(400);
  }
}

const kobo = (text: unknown) => BigInt(String(text ?? "").replace(/[^0-9]/g, "") || "0") * 100n;

async function main() {
  const t = await login();
  const me = (await db.from("users").select("id").eq("secret_name", "STELLAR_SECRET_FUNMI").single()).data as { id: string };

  console.log("1. Her goal");
  const s0 = await t("savings_status");
  check(s0.has_goal && s0.ready, `goal "${String(s0.goal_name)}": ${String(s0.saved_text)} of ${String(s0.goal_text)}, pot on Stellar`);
  const start = kobo(s0.saved_text);

  console.log("2. Save ₦1,000");
  const p = await t("prepare_save", { amount: 1000 });
  check(p.ok && p.requires_pin === false, `prepare_save: "${String(p.text)}"`);
  const c = await t("confirm_action", { action_id: p.action_id });
  check(c.ok, `confirm_action: ${String(c.text)}`);
  const saved = await completed(String(c.transaction_id), "pot_fund");
  check(true, `pot_fund on Stellar in ${saved.secs.toFixed(1)} s: https://stellar.expert/explorer/testnet/tx/${saved.hash}`);
  const s1 = await t("savings_status");
  check(kobo(s1.saved_text) === start + 100_000n, `the pot holds ${String(s1.saved_text)} (read from the contract)`);

  console.log("3. Money in, then auto-save");
  const ref = `e2e_savings_${Date.now()}`;
  const r = await db.rpc("ng_bank_transfer_in", { p_user_id: me.id, p_amount: 200_000, p_repay: 0, p_ref: ref, p_sender: "A customer" });
  if (r.error) throw new Error(r.error.message);
  const { data: auto } = await db.from("transactions").select("id, amount").eq("user_id", me.id).eq("kind", "saved").eq("source", "auto_save").like("ref", `%${ref}%`).maybeSingle();
  const { data: loanRow } = await db.from("transactions").select("amount").eq("user_id", me.id).eq("kind", "loan_repay").like("ref", `%${ref}%`).maybeSingle();
  const loanShare = loanRow ? -BigInt(loanRow.amount) : 0n;
  const expected = ((200_000n - loanShare) * 1000n) / 10000n;
  check(auto && -BigInt(auto.amount) === expected, `auto-save queued: ₦${Number(expected) / 100} (10% of ₦${Number(200_000n - loanShare) / 100}, after a loan share of ₦${Number(loanShare) / 100})`);
  const a = await completed(String(auto!.id), "auto-save");
  check(true, `auto-save pot_fund on Stellar in ${a.secs.toFixed(1)} s`);
  const s2 = await t("savings_status");
  check(kobo(s2.saved_text) === start + 100_000n + expected, `the pot holds ${String(s2.saved_text)}`);

  console.log("4. Take it back out");
  const back = 100_000n + expected;
  const w = await t("prepare_withdraw_savings", { amount: Number(back / 100n) });
  check(w.ok, `prepare_withdraw_savings: "${String(w.text)}"`);
  const wc = await t("confirm_action", { action_id: w.action_id });
  check(wc.ok, `confirm_action: ${String(wc.text)}`);
  const out = await completed(String(wc.transaction_id), "pot_send");
  check(true, `pot_send on Stellar in ${out.secs.toFixed(1)} s`);
  const s3 = await t("savings_status");
  check(kobo(s3.saved_text) === start, `back to ${String(s3.saved_text)}`);
  const big = await t("prepare_withdraw_savings", { amount: 6000 });
  check(big.requires_pin === true, "taking out over ₦5,000 needs her PIN");
  await t("reject_action", { action_id: big.action_id });
  console.log("\nSavings e2e passed.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
