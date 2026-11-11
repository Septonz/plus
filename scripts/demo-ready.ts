// pnpm demo:ready: before every rehearsal. Resets the demo people, warms every Edge Function, then
// checks what the demo needs and prints a green "ready" or exactly what is wrong.
//
//   pnpm demo:ready          Nigeria and India
//   pnpm demo:ready ng       one market only (also: in)
//   pnpm demo:ready --check  skip the reset and warm-up; checks only
//
// Checks: every function's /health (with the agent secret), agent-tools' deep warm-up, the cron jobs
// (ran in the last 2 minutes, and their Edge Function calls answer 2xx), the chain outbox (nothing
// stuck), Stellar RPC and Horizon (healthy, ledger fresh), the plus_credit contract (deployed, partner
// is its writer, Funmi's assets readable, no credit write stuck), and a warmed first read as Funmi
// under 1 second. TESTNET and the dev project only.
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import * as StellarSdk from "@stellar/stellar-sdk";
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

/** A read-only plus_credit call through RPC simulation (no key, nothing sent). */
async function creditRead(id: string, fn: string, args: unknown[] = []) {
  const { Account, Contract, Networks, TransactionBuilder, rpc, scValToNative } = StellarSdk;
  const server = new rpc.Server(RPC_URL);
  const tx = new TransactionBuilder(new Account("GBGBYS2ZQRB4F4IIUOWMS2GG4B574LGYIKP5AJA2HRHVJNX3OIYRYNN5", "0"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(id).call(fn, ...(args as never[]))).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error(rpc.Api.isSimulationError(sim) ? sim.error : "no result");
  return scValToNative(sim.result.retval);
}

async function credit() {
  console.log("\n== plus_credit (loans, assets, vouches)");
  const id = process.env.PLUS_CREDIT_CONTRACT_ID;
  if (!id) {
    problems.push("PLUS_CREDIT_CONTRACT_ID is not set in .env.local (docs/deployments.md has it)");
    return line(false, "plus_credit contract", "not configured");
  }
  try {
    const [cfg, ms] = await timed(() => creditRead(id, "config") as Promise<{ admin: string; partner: string }>);
    const ok = cfg.partner === "GCHDENOIJ5JFA3JU3OPW3LZSLHR57HCOHA7ZYQSRYG6MHHOFSAM4CWWZ";
    line(ok, "deployed; partner writes", `${id.slice(0, 8)}…, ${ms} ms`);
    if (!ok) problems.push(`plus_credit's partner is ${cfg.partner}, not Plus's partner account`);
    const { data: funmi } = await db.from("users").select("id").eq("stellar_pub", "GA6K725VCN45F4LWZYEL3H7J5CIGGL2IUXDWZH5X75GYWQQJNPAYGW6M").maybeSingle();
    if (funmi) {
      const { data: ref } = await db.rpc("credit_borrower_ref", { p_user_id: funmi.id });
      const assets = await creditRead(id, "assets_of", [StellarSdk.xdr.ScVal.scvBytes(Buffer.from(String(ref), "hex"))]) as unknown[];
      line(assets.length > 0, "Funmi's verified assets are on it", `${assets.length} asset(s)`);
      if (assets.length === 0) problems.push("Funmi has no assets on plus_credit: run the backfill (select public.credit_backfill())");
      // Piece 10: Tunde's vouch is waiting on-chain; Amaka can vouch live (the second one).
      const vouches = await creditRead(id, "vouches_for", [StellarSdk.xdr.ScVal.scvBytes(Buffer.from(String(ref), "hex"))]) as unknown[];
      const { data: amaka } = await db.from("users").select("id").eq("name", "Amaka").eq("market_id", "ng").is("archived_at", null).maybeSingle();
      const { data: can } = amaka ? await db.rpc("vouch_check", { p_voucher: amaka.id, p_borrower: funmi.id }) : { data: null };
      const vok = vouches.length === 1 && (can as { ok?: boolean } | null)?.ok === true;
      line(vok, "vouches: Tunde's is waiting for Funmi's loan; Amaka can vouch", `${vouches.length} waiting; Amaka ${(can as { ok?: boolean; reason?: string } | null)?.ok ? "can" : `can't (${(can as { reason?: string } | null)?.reason})`}`);
      if (!vok) problems.push("Funmi's vouches aren't in the demo state (one waiting from Tunde, Amaka able to vouch): pnpm demo:reset ng");
    }
  } catch (e) {
    problems.push(`plus_credit read failed: ${e instanceof Error ? e.message : e}`);
    line(false, "plus_credit contract", e instanceof Error ? e.message : String(e));
  }
  const { data: stuck } = await db.from("chain_outbox").select("ref, status, attempts, last_error")
    .eq("args->>contract", "credit").neq("status", "done").lt("created_at", new Date(Date.now() - 120_000).toISOString());
  line((stuck ?? []).length === 0, "no plus_credit write waiting over 2 minutes", (stuck ?? []).map((r) => `${r.ref} ${r.status}`).join(", "));
  if ((stuck ?? []).length) problems.push(`plus_credit writes stuck: ${(stuck ?? []).map((r) => `${r.ref} (${r.status}, ${r.attempts}x: ${r.last_error ?? ""})`).join("; ")}`);
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

/**
 * Piece 11: every path of the 60-second demo, timed (and so warmed). Reads as Funmi; money paths
 * are prepared and then cancelled (nothing moves), and "Yes to tick" is a tiny XLM payment from
 * the partner to itself through the same outbox and worker her payments use.
 */
const timings: [string, number][] = [];
async function demoPaths() {
  if (!markets.includes("ng")) return;
  console.log("\n== The demo's paths, warmed and timed (Funmi)");
  const c = createClient(url, process.env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signInWithPassword({ email: "demo-funmi@example.com", password: process.env.VITE_DEMO_LOGIN_PASSWORD! });
  if (error) return line(false, "Funmi signs in", error.message);
  const tool = (name: string, body: Record<string, unknown> = {}) => fetch(`${url}/functions/v1/agent-tools/${name}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<Record<string, unknown>>);
  const time = async (label: string, f: () => Promise<Record<string, unknown> | void>) => {
    const [r, ms] = await timed(f);
    timings.push([label, ms]);
    const err = r && (r as Record<string, unknown>).error;
    line(ms < 2000 && !err, label, `${ms} ms${err ? ` (${String(err)})` : ""}`);
    return r;
  };
  for (const [label, name] of [["balance", "get_balance"], ["ajo", "group_status"], ["loan offer", "loan_status"], ["savings", "savings_status"],
    ["vouches", "my_vouches"], ["activity", "my_record"], ["cash-out codes", "cash_outs"]] as const) {
    await time(label, () => tool(name));
  }
  // Prepared, then cancelled: warms the prepare and confirm paths without moving money.
  for (const [label, name, body] of [["pay Iya Tunde (prepare)", "prepare_pay", { payee: "Iya Tunde", amount: 2000 }],
    ["pay my ajo (prepare)", "prepare_ajo_contribution", {}], ["accept loan (prepare)", "prepare_loan", {}],
    ["cash out (prepare)", "prepare_cashout", { amount: 3000 }], ["save (prepare)", "prepare_save", { amount: 1000 }]] as const) {
    const r = await time(label, () => tool(name, body as Record<string, unknown>)) as Record<string, unknown> | undefined;
    if (r?.action_id) await tool("reject_action", { action_id: r.action_id });
  }
  // Yes to tick: the outbox and worker, as for her payments.
  const t0 = Date.now();
  const { data: id, error: e } = await db.rpc("chain_enqueue_on", { p_signer: "partner", p_kind: "payment", p_ref: `demo_ready:${crypto.randomUUID()}`,
    p_args: { asset: "XLM", to: "GCHDENOIJ5JFA3JU3OPW3LZSLHR57HCOHA7ZYQSRYG6MHHOFSAM4CWWZ", amount: "1" } });
  if (e) return line(false, "Yes to tick", e.message);
  await fetch(`${url}/functions/v1/chain-worker`, { method: "POST", headers: { "x-plus-secret": process.env.AGENT_SHARED_SECRET! } }).then((r) => r.body?.cancel());
  for (;;) {
    const { data: row } = await db.from("chain_outbox").select("status").eq("id", Number(id)).single();
    if (row?.status === "done" || row?.status === "failed" || Date.now() - t0 > 60_000) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const ms = Date.now() - t0;
  timings.push(["Yes to tick (on Stellar)", ms]);
  line(ms <= 5000, "Yes to tick (on Stellar)", `${(ms / 1000).toFixed(1)} s`);
  if (ms > 5000) warnings.push(`Yes to tick took ${(ms / 1000).toFixed(1)} s (target ≤ 5 s); testnet ledgers close every ~5 s`);
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
  await credit();
  await firstTap();
  await demoPaths();

  const secs = Math.round((Date.now() - t0) / 1000);
  if (timings.length) {
    console.log("\n  Measured:");
    for (const [label, ms] of timings) console.log(`    ${label.padEnd(26)} ${ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`}`);
  }
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
