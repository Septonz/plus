// pnpm warm: wake every Edge Function the demo uses, so the first tap of the demo doesn't pay for a
// cold start. Calls GET /functions/v1/<fn>/health (no database, nothing secret; scheduler and
// sync-events want the agent secret even there) twice per
// function and prints whether the first call found it cold.
//
//   pnpm warm            once, right before the demo
//   pnpm warm --watch    keep them warm: again every 4 minutes until Ctrl+C
//
// The same pings run from Supabase Cron every 5 minutes (scheduler/warm) while the Supabase secret
// DEMO_WARM is "true".
import { adminClient, loadLocalEnv } from "./lib/supabase-admin.ts";

loadLocalEnv();
const { url } = adminClient();
const FUNCTIONS = ["agent-tools", "chain-worker", "agent-api", "voice-session", "helper-api", "payout-sim", "scheduler", "sync-events"];

async function ping(fn: string): Promise<{ ms: number; cold: boolean | null; status: number }> {
  const t0 = performance.now();
  try {
    // scheduler and sync-events answer /health only with the agent secret (they run without a JWT check).
    const r = await fetch(`${url}/functions/v1/${fn}/health`, {
      headers: { "x-plus-secret": process.env.AGENT_SHARED_SECRET ?? "" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await r.json().catch(() => ({})) as { cold?: boolean };
    return { ms: Math.round(performance.now() - t0), cold: body.cold ?? null, status: r.status };
  } catch {
    return { ms: Math.round(performance.now() - t0), cold: null, status: 0 };
  }
}

async function round() {
  const rows = await Promise.all(FUNCTIONS.map(async (fn) => {
    const first = await ping(fn);
    const second = await ping(fn);
    return { fn, first, second };
  }));
  console.log(`\nWarm-up ${new Date().toLocaleTimeString()}`);
  console.log("  function        first call            second call");
  let failed = 0;
  for (const { fn, first, second } of rows) {
    const ok = first.status === 200 && second.status === 200;
    if (!ok) failed++;
    const state = first.status !== 200 ? `HTTP ${first.status}` : first.cold ? "was cold" : "already warm";
    console.log(`  ${ok ? "✓" : "✗"} ${fn.padEnd(14)} ${String(first.ms).padStart(5)} ms  ${state.padEnd(13)} ${String(second.ms).padStart(5)} ms`);
  }
  if (failed) {
    console.log(`  ${failed} function(s) did not answer /health; deploy them (README, Scripts).`);
    process.exitCode = 1;
  }
}

await round();
if (process.argv.includes("--watch")) {
  console.log("\nKeeping them warm every 4 minutes. Ctrl+C to stop.");
  setInterval(() => void round(), 4 * 60_000);
}
