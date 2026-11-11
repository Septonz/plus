// pnpm demo:ready: before every rehearsal. Resets the demo people, warms every Edge Function, then
// checks what the demo needs and prints a green "ready" or exactly what is wrong.
//
//   pnpm demo:ready          Nigeria and India
//   pnpm demo:ready ng       one market only (also: in)
//   pnpm demo:ready --check  skip the reset and warm-up; checks only
//
// Checks: every function's /health (with the agent secret), agent-tools' deep warm-up, the cron jobs
// (ran in the last 2 minutes, and their Edge Function calls answer 2xx), the chain outbox (nothing
// stuck), Stellar RPC and Horizon (healthy, ledger fresh), and a warmed first read as Funmi under
// 1 second. TESTNET and the dev project only.
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { adminClient, loadLocalEnv, ROOT } from "./lib/supabase-admin.ts";

loadLocalEnv();
const { db, url } = adminClient();
const args = process.argv.slice(2);
const onlyCheck = args.includes("--check");
const markets = args.includes("ng") ? ["ng"] : args.includes("in") ? ["in"] : ["ng", "in"];
const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-rpc.testnet.stellar.gateway.fm";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FUNCTIONS = ["agent-tools", "chain-worker", "agent-api", "voice-session", "helper-api", "payout-sim", "scheduler", "sync-events"];

const problems: string[] = [];
const warnings: string[] = [];
const t0 = Date.now();
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
function line(ok: boolean, what: string, detail = "") {
  console.log(`  ${ok ? green("✓") : red("✗")} ${what}${detail ? `  ${detail}` : ""}`);
}

function run(label: string, cmd: string, cmdArgs: string[]): boolean {
  console.log(`\n== ${label}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) problems.push(`${label} failed (exit ${r.status}); see its output above`);
  return r.status === 0;
}

async function timed<T>(f: () => Promise<T>): Promise<[T, number]> {
  const s = performance.now();
  const v = await f();
  return [v, Math.round(performance.now() - s)];
}

async function functions() {
  console.log("\n== Edge Functions");
  for (const fn of FUNCTIONS) {
    const [r, ms] = await timed(() => fetch(`${url}/functions/v1/${fn}/health`, {
      headers: { "x-plus-secret": process.env.AGENT_SHARED_SECRET ?? "" }, signal: AbortSignal.timeout(15_000),
    }).then((x) => x.status, () => 0));
    line(r === 200, fn, `${ms} ms`);
    if (r !== 200) problems.push(`${fn}/health answered ${r || "nothing"} (deploy it: npx supabase functions deploy ${fn} --project-ref qoqmnjzfjhpemwleipth --yes)`);
    else if (ms > 1000) warnings.push(`${fn}/health took ${ms} ms after the warm-up`);
  }
  const [deep, ms] = await timed(() => fetch(`${url}/functions/v1/agent-tools/warm`, {
    headers: { "x-plus-secret": process.env.AGENT_SHARED_SECRET ?? "" }, signal: AbortSignal.timeout(15_000),
  }).then((x) => x.status, () => 0));
  line(deep === 200, "agent-tools deep warm-up (database and Stellar RPC)", `${ms} ms`);
  if (deep !== 200) problems.push(`agent-tools/warm answered ${deep || "nothing"}`);
}

type Health = {
  jobs: { name: string; schedule: string; active: boolean; last_status: string | null; last_seconds_ago: number | null }[];
  http_ok: number; http_failed: number; http_failed_codes: string[]; outbox_waiting: number; outbox_oldest_seconds: number | null;
};

async function cron() {
  console.log("\n== Cron jobs and the chain outbox");
  const { data, error } = await db.rpc("demo_health");
  if (error || !data) {
    problems.push(`demo_health() failed: ${error?.message ?? "no data"} (run: npx supabase db push --remote --yes)`);
    return line(false, "demo_health()", error?.message ?? "");
  }
  const h = data as Health;
  for (const j of h.jobs) {
    const every = j.schedule.startsWith("*/") ? Number(j.schedule.slice(2).split(" ")[0]) * 60 : 60;
    const ok = j.active && j.last_status === "succeeded" && j.last_seconds_ago !== null && j.last_seconds_ago <= every + 60;
    line(ok, j.name, `${j.schedule}; last ${j.last_status ?? "never"}${j.last_seconds_ago !== null ? `, ${j.last_seconds_ago} s ago` : ""}`);
    if (!ok) problems.push(`cron job ${j.name}: ${!j.active ? "inactive" : `last run ${j.last_status ?? "never"}${j.last_seconds_ago !== null ? ` ${j.last_seconds_ago} s ago` : ""}`}`);
  }
  const httpErrors = h.http_failed_codes.filter((c) => /^\d+$/.test(c));
  const timeouts = h.http_failed - httpErrors.length;
  line(httpErrors.length === 0, "their function calls (last 5 minutes)", `${h.http_ok} answered 2xx${h.http_failed ? `, ${h.http_failed} not` : ""}`);
  if (httpErrors.length) problems.push(`cron calls to Edge Functions answered HTTP ${httpErrors.join(", ")} in the last 5 minutes (check verify_jwt: pnpm functions:check-jwt)`);
  else if (timeouts > 2) problems.push(`${timeouts} cron calls timed out in the last 5 minutes`);
  else if (timeouts > 0) warnings.push(`${timeouts} cron call(s) timed out in the last 5 minutes (occasional pg_net DNS timeouts; the next minute retries)`);
  const stuck = (h.outbox_oldest_seconds ?? 0) > 180;
  line(!stuck, "chain outbox", h.outbox_waiting ? `${h.outbox_waiting} waiting, oldest ${h.outbox_oldest_seconds} s` : "empty");
  if (stuck) problems.push(`chain outbox: ${h.outbox_waiting} rows waiting, the oldest for ${h.outbox_oldest_seconds} s (is chain-worker running?)`);
}

async function stellar() {
  console.log("\n== Stellar testnet");
  const [rpcHealth, ms] = await timed(() => fetch(RPC_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }), signal: AbortSignal.timeout(10_000),
  }).then((r) => r.json() as Promise<{ result?: { status: string; latestLedger: number } }>, () => null));
  const rpcOk = rpcHealth?.result?.status === "healthy";
  line(rpcOk, "Stellar RPC", `${rpcHealth?.result?.status ?? "no answer"}, ledger ${rpcHealth?.result?.latestLedger ?? "?"}, ${ms} ms`);
  if (!rpcOk) problems.push(`Stellar RPC ${RPC_URL}: ${rpcHealth?.result?.status ?? "no answer"}`);
  const [hz, hms] = await timed(() => fetch(`${HORIZON_URL}/ledgers?order=desc&limit=1`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => r.json() as Promise<{ _embedded?: { records?: { closed_at: string }[] } }>, () => null));
  const closed = hz?._embedded?.records?.[0]?.closed_at;
  const age = closed ? Math.round((Date.now() - Date.parse(closed)) / 1000) : null;
  const hzOk = age !== null && age < 60;
  line(hzOk, "Horizon", `${age !== null ? `last ledger ${age} s ago` : "no answer"}, ${hms} ms`);
  if (!hzOk) problems.push(`Horizon ${HORIZON_URL}: ${age !== null ? `last ledger ${age} s ago` : "no answer"}`);
}

async function firstTap() {
  console.log("\n== A first tap, after the warm-up");
  const c = createClient(url, process.env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signInWithPassword({ email: "demo-funmi@example.com", password: process.env.VITE_DEMO_LOGIN_PASSWORD! });
  if (error) {
    problems.push(`Funmi's demo login: ${error.message} (DEMO_LOGINS_ENABLED? pnpm demo:logins)`);
    return line(false, "Funmi signs in", error.message);
  }
  const [r, ms] = await timed(() => fetch(`${url}/functions/v1/agent-tools/get_balance`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${data.session.access_token}` }, body: "{}",
  }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => ({})) as { text?: string } }), () => ({ status: 0, body: {} as { text?: string } })));
  const ok = r.status === 200 && ms < 1000;
  line(ok, "Funmi's balance", `${ms} ms: ${r.body.text ?? r.status}`);
  if (r.status !== 200) problems.push(`agent-tools/get_balance as Funmi answered ${r.status}`);
  else if (ms >= 1000) problems.push(`a warmed first tap took ${ms} ms (target: under 1 s); run pnpm warm again`);
}

async function main() {
  if ((process.env.STELLAR_NETWORK ?? "testnet") !== "testnet") throw new Error("testnet only");
  if (!onlyCheck) {
    for (const m of markets) run(`Reset (${m === "ng" ? "Nigeria" : "India"})`, `pnpm -s demo:reset ${m === "ng" ? "ng" : "in"}`);
    run("Warm-up", "node scripts/warm.ts");
  }
  await functions();
  await cron();
  await stellar();
  await firstTap();

  const secs = Math.round((Date.now() - t0) / 1000);
  console.log("");
  for (const w of warnings) console.log(yellow(`  note: ${w}`));
  if (problems.length === 0) {
    console.log(green(`\n  READY  (${secs} s)`) + "  https://plus-wallet.vercel.app");
  } else {
    console.log(red(`\n  NOT READY: ${problems.length} problem(s)`));
    for (const p of problems) console.log(red(`  - ${p}`));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(red(`demo:ready failed: ${e instanceof Error ? e.message : e}`));
  process.exit(1);
});
