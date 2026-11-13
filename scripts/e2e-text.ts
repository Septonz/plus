// pnpm e2e:text: Type to Plus end to end (piece 13, item 2). TESTNET and the dev project only.
// Funmi's demo login types commands to the text-command function (deterministic parser, no LLM, no
// ElevenLabs). Money commands only PREPARE: each prepared action is rejected again at the end, so
// nothing moves. Checks that no voice session was started during the run.
import { createClient } from "@supabase/supabase-js";
import { adminClient, loadLocalEnv } from "./lib/supabase-admin.ts";

loadLocalEnv();
const { db, url } = adminClient();
const c = createClient(url, process.env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
const { data, error } = await c.auth.signInWithPassword({ email: "demo-funmi@example.com", password: process.env.VITE_DEMO_LOGIN_PASSWORD! });
if (error) throw new Error(`login: ${error.message}`);
const token = data.session.access_token;
const since = new Date().toISOString();

let failed = 0;
const say = async (text: string) => {
  const t0 = Date.now();
  const r = await fetch(`${url}/functions/v1/text-command`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ text }),
  });
  return { status: r.status, ms: Date.now() - t0, ...(await r.json()) as Record<string, any> };
};
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
};

const prepared: string[] = [];
const cases: [string, (r: Record<string, any>) => boolean, string][] = [
  ["How much money dey my wallet?", (r) => r.tool === "get_balance" && /naira/.test(r.text ?? ""), "balance (Pidgin)"],
  ["balance", (r) => r.tool === "get_balance", "balance"],
  ["pay Iya Tunde 2k", (r) => r.tool === "prepare_pay" && Boolean(r.result?.action_id), "pay a saved person (2k)"],
  ["abeg send two thousand give Iya Tunde", (r) => r.tool === "prepare_pay" && Boolean(r.result?.action_id), "pay (Pidgin, words)"],
  ["save one thousand", (r) => r.tool === "prepare_save" && Boolean(r.result?.action_id), "save ₦1,000"],
  ["cash out 3000", (r) => r.tool === "prepare_cashout" && Boolean(r.result?.action_id), "cash out"],
  ["can I get a loan", (r) => r.tool === "loan_status" && /30,000/.test(r.text ?? ""), "loan offer and why"],
  ["share my record", (r) => r.kind === "tool" || r.kind === "navigate", "share record"],
  ["open savings", (r) => r.kind === "navigate", "open a screen"],
  ["purple elephant", (r) => r.kind === "unknown" && r.suggestions?.length === 3, "unknown -> 3 suggestions"],
];
console.log("Type to Plus (Funmi)");
for (const [text, ok, label] of cases) {
  const r = await say(text);
  if (r.result?.action_id) prepared.push(String(r.result.action_id));
  check(ok(r), `${label}: “${text}”`, `${r.ms} ms · ${r.kind}${r.tool ? ` ${r.tool}` : r.screen ? ` ${r.screen}` : ""} · ${String(r.text ?? r.echo ?? "").slice(0, 70)}`);
}

// Nothing moves: every prepared action is cancelled again (her Yes was never given).
for (const id of prepared) await db.from("pending_actions").update({ status: "expired" }).eq("id", id).eq("status", "pending");
console.log(`  ${prepared.length} prepared actions expired again (nothing moved)`);
const { count } = await db.from("voice_sessions").select("id", { count: "exact", head: true }).gte("at", since);
check(count === 0, "0 voice sessions started during the run (ElevenLabs never called)", String(count));
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
