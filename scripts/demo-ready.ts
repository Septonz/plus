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
// under 1 second; for Nigeria also public test mode (piece 12: the guest pool, the shared demo agent's
// float, the guests' treasury and fee runway, voice mode and today's conversations against the cap).
// TESTNET and the dev project only.
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
    // "* * * * *" every minute, "*/n ..." every n minutes; anything else (the nightly guest reset) daily.
    const daily = !j.schedule.startsWith("*");
    const every = j.schedule.startsWith("*/") ? Number(j.schedule.slice(2).split(" ")[0]) * 60 : daily ? 86_400 : 60;
    const ok = j.active && ((daily && j.last_status === null) ||
      (j.last_status === "succeeded" && j.last_seconds_ago !== null && j.last_seconds_ago <= every + 60));
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
 * Piece 12: public test mode. The guest pool (seeded, reset, funded), the shared demo agent's float,
 * the guests' treasury and its runway, the partner's XLM for fees, and voice (mode, today's
 * conversations against the cap, a presenter code or unlock to present with).
 */
async function publicTest() {
  console.log("\n== Public test mode");
  const want = Math.max(1, Math.min(30, Number(process.env.GUEST_POOL_SIZE ?? 20) || 20));
  type Place = { kind: string; slot: number; user_id: string | null; helper_id: string | null; reset_started_at: string | null; reset_done_at: string | null; reset_requested_at: string | null; reset_error: string | null };
  const { data: rows, error } = await db.from("guest_pool").select("kind, slot, user_id, helper_id, reset_started_at, reset_done_at, reset_requested_at, reset_error");
  if (error) {
    problems.push(`guest_pool: ${error.message} (npx supabase db push --remote --yes)`);
    return line(false, "guest pool");
  }
  const places = (rows ?? []) as Place[];
  const traders = places.filter((p) => p.kind === "trader" && p.user_id);
  const ready = (p: Place) => Boolean(p.reset_done_at) && (!p.reset_started_at || p.reset_done_at! >= p.reset_started_at);
  const readyN = traders.filter(ready).length;
  const broken = places.filter((p) => p.reset_error);
  line(traders.length >= want, "guest traders seeded", `${traders.length} of ${want}`);
  if (traders.length < want) problems.push(`only ${traders.length} of ${want} guest traders: pnpm guests:seed`);
  line(readyN === traders.length && broken.length === 0, "guest resets", `${readyN} ready${broken.length ? `, ${broken.length} with errors (${broken.map((p) => `${p.kind} ${p.slot}: ${p.reset_error}`).join("; ").slice(0, 160)})` : ""}`);
  if (broken.length) problems.push(`guest resets failing: pnpm guests:status`);
  else if (readyN < traders.length) warnings.push(`${traders.length - readyN} guest(s) still resetting (the scheduler finishes them within minutes; pnpm guests:status)`);
  const agents = places.filter((p) => p.kind === "agent" && p.helper_id);
  line(agents.length >= 4, "guest agents", `${agents.length} (the shared demo agent and 3 for "Try the agent app")`);
  if (agents.length < 4) problems.push("guest agents missing: pnpm guests:seed");

  const { data: wallets } = await db.from("system_wallets").select("signer, pub").in("signer", ["guest_treasury", "guest_agent0", "partner"]);
  const pub = (s: string) => (wallets ?? []).find((w) => w.signer === s)?.pub as string | undefined;
  const bal = async (p: string | undefined) => {
    if (!p) return null;
    const a = await fetch(`${HORIZON_URL}/accounts/${p}`).then((r) => r.ok ? r.json() : null, () => null) as { balances: { asset_type: string; asset_code?: string; balance: string }[] } | null;
    if (!a) return null;
    return { ngnt: Number(a.balances.find((b) => b.asset_code === "NGNT")?.balance ?? 0), xlm: Number(a.balances.find((b) => b.asset_type === "native")?.balance ?? 0) };
  };
  const [agent0, treasury, partner] = await Promise.all([bal(pub("guest_agent0")), bal(pub("guest_treasury")), bal(pub("partner"))]);
  const floatOk = (agent0?.ngnt ?? 0) >= 100_000;
  line(floatOk, "shared demo agent's float", agent0 ? `₦${agent0.ngnt.toLocaleString("en-NG")}` : "no wallet");
  if (!floatOk) problems.push("the shared demo agent's float is under ₦100,000: pnpm guests:reset agents");
  // Worst case a night: every guest took the ₦30,000 loan and moved ₦10,000 more, all made good from the treasury.
  const nightly = want * 40_000;
  const days = treasury ? Math.floor(treasury.ngnt / nightly) : 0;
  line(days >= 14, "guests' treasury", treasury ? `₦${Math.round(treasury.ngnt).toLocaleString("en-NG")}: about ${days} days at ₦${nightly.toLocaleString("en-NG")} a night` : "no wallet");
  if (days < 14) problems.push("the guests' treasury has under 2 weeks of runway: pnpm guests:seed tops it up");
  // Fees: Plus fee-bumps every guest transaction from the partner account. ~20 transactions a reset,
  // up to 3 resets a guest a day, at most ~0.02 XLM each (Soroban calls cost more than payments).
  const xlmDay = want * 3 * 20 * 0.02;
  const xlmDays = partner ? Math.floor(partner.xlm / xlmDay) : 0;
  line(xlmDays >= 14, "partner XLM for fees", partner ? `${Math.round(partner.xlm).toLocaleString("en")} XLM: about ${xlmDays} days at ${xlmDay} XLM a day` : "no wallet");
  if (xlmDays < 14) problems.push("the partner account has under 2 weeks of XLM for guest fees: send it testnet XLM");

  const c = createClient(url, process.env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data: s } = await c.auth.signInWithPassword({ email: "demo-funmi@example.com", password: process.env.VITE_DEMO_LOGIN_PASSWORD! });
  const v = s?.session
    ? await fetch(`${url}/functions/v1/voice-session/status`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.session.access_token}` }, body: "{}" })
      .then((r) => r.json(), () => null) as { mode?: string; today?: number; cap?: number; unlocks?: number; presenter_code_set?: boolean; configured?: boolean } | null
    : null;
  if (!v?.mode) {
    problems.push("voice-session/status did not answer");
    return line(false, "voice");
  }
  line(v.mode !== "on", "voice mode", `${v.mode}${v.mode === "on" ? " (public testers can spend ElevenLabs credits: set VOICE_MODE=presenter)" : ""}`);
  if (v.mode === "on") problems.push("VOICE_MODE is on: public testers would spend ElevenLabs credits (npx supabase secrets set VOICE_MODE=presenter --project-ref qoqmnjzfjhpemwleipth)");
  line((v.today ?? 0) < (v.cap ?? 0), "voice conversations today", `${v.today ?? 0} of ${v.cap ?? "?"} (VOICE_DAILY_SESSION_CAP)`);
  if ((v.today ?? 0) >= (v.cap ?? 0)) warnings.push("today's voice cap is used up: new conversations are refused until midnight (Lagos)");
  const canPresent = v.mode === "off" || Boolean(v.presenter_code_set) || (v.unlocks ?? 0) > 0;
  line(canPresent, "presenter unlock", `${v.presenter_code_set ? "code set" : "no VOICE_PRESENTER_CODE"}, ${v.unlocks ?? 0} device(s) unlocked (staff login on /demo works too)`);
  if (!canPresent) problems.push("no way to unlock voice for a presenter: set VOICE_PRESENTER_CODE (npx supabase secrets set VOICE_PRESENTER_CODE=... --project-ref qoqmnjzfjhpemwleipth) or sign in on /demo as staff");
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
  if (markets.includes("ng")) await publicTest();

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
