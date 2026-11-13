// pnpm recording:reset: the staff /demo button "Reset for recording", from a terminal. TESTNET and
// the dev project only. Calls the deployed demo-control function (the same code as the button) with
// the agent secret: the database half at once, then one Stellar step every 3 s until done.
import { adminClient, loadLocalEnv, publishableKey } from "./lib/supabase-admin.ts";

loadLocalEnv();
const { url } = adminClient();
const headers = { "content-type": "application/json", authorization: `Bearer ${publishableKey()}`, apikey: publishableKey(), "x-plus-secret": process.env.AGENT_SHARED_SECRET ?? "" };
const post = async (path: string, body: unknown = {}) => {
  const r = await fetch(`${url}/functions/v1/demo-control/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const j = await r.json() as Record<string, unknown>;
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};

const t0 = Date.now();
const { gen } = await post("recording-reset") as { gen: number };
console.log(`database half done (${Date.now() - t0} ms)`);
for (let i = 0; i < 60; i++) {
  const s = await post("recording-step", { gen }) as { done: boolean; step: string; note?: string; warm?: { path: string; status: number; ms: number }[] };
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)} s  ${s.step}${s.note ? `: ${s.note}` : ""}`);
  if (s.done) {
    for (const w of s.warm ?? []) console.log(`    warm ${w.path.padEnd(22)} ${w.status} ${w.ms} ms`);
    console.log(`Ready to record (${Math.round((Date.now() - t0) / 1000)} s)`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.error("not done after 3 minutes");
process.exit(1);
