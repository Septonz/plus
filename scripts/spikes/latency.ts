// SPIKE: latency of the deployed agent-tools webhooks, against a 5-second voice budget.
//
//   node scripts/spikes/latency.ts            (N=20 calls per tool; N env var to change)
//
// Reads AGENT_SHARED_SECRET and DEMO_SELVI_PHONE from the environment or the gitignored root
// .env.local; never prints them. Measures the round trip from this machine (what ElevenLabs
// adds on top is its own network hop), the function's own latency_ms, and one contract read
// (record_of for Selvi) timed inside the function.
import { loadLocalEnv } from "../lib/supabase-admin.ts";

loadLocalEnv();

const URL_BASE = process.env.AGENT_TOOLS_URL ?? "https://qoqmnjzfjhpemwleipth.supabase.co/functions/v1/agent-tools";
const SECRET = process.env.AGENT_SHARED_SECRET;
const PHONE = process.env.DEMO_SELVI_PHONE;
const N = Number(process.env.N ?? 20);
const BUDGET_MS = 5000;
if (!SECRET) throw new Error("AGENT_SHARED_SECRET is not set (root .env.local)");
if (!PHONE) throw new Error("DEMO_SELVI_PHONE is not set");

type Res = { status: number; ms: number; serverMs?: number; body: Record<string, unknown> };

async function call(tool: string, callerId: string): Promise<Res> {
  const t = performance.now();
  const r = await fetch(`${URL_BASE}/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-plus-secret": SECRET! },
    body: JSON.stringify({ caller_id: callerId }),
  });
  const body = (await r.json()) as Record<string, unknown>;
  return { status: r.status, ms: performance.now() - t, serverMs: body.latency_ms as number | undefined, body };
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]);
}

// WhatsApp passes the number as digits without "+": use that form, as ElevenLabs would.
const whatsappId = PHONE.replace(/^\+/, "");

// Auth check first: a wrong secret must be refused.
const bad = await fetch(`${URL_BASE}/get_user`, { method: "POST", headers: { "x-plus-secret": "wrong" }, body: "{}" });
console.log(`wrong secret -> ${bad.status} (expect 401)\n`);

const rows: string[] = [];
for (const tool of ["get_user", "get_balance", "what_arrived"]) {
  const runs: Res[] = [];
  for (let i = 0; i < N; i++) runs.push(await call(tool, whatsappId));
  const errors = runs.filter((r) => r.status !== 200).length;
  const rt = runs.map((r) => r.ms);
  const sv = runs.map((r) => r.serverMs ?? 0);
  console.log(`${tool}: "${runs.at(-1)!.body.text}"`);
  rows.push(
    `| ${tool} | ${N} | ${errors} | ${Math.round(rt[0])} | ${pct(rt, 50)} | ${pct(rt, 95)} | ${pct(sv, 50)} | ${pct(sv, 95)} |`,
  );
}

const rec: Res[] = [];
for (let i = 0; i < Math.min(N, 10); i++) rec.push(await call("_time_record_of", whatsappId));
const sim = rec.map((r) => Number(r.body.simulate_ms ?? 0));
const imp = rec.map((r) => Number(r.body.sdk_import_ms ?? 0));
const recRt = rec.map((r) => r.ms);

console.log(`\nRound trip from this machine (ms); server = latency_ms reported by the function\n`);
console.log("| tool | calls | errors | first | p50 | p95 | server p50 | server p95 |");
console.log("| ---- | ----- | ------ | ----- | --- | --- | ---------- | ---------- |");
for (const r of rows) console.log(r);
console.log(
  `| record_of (contract read) | ${rec.length} | ${rec.filter((r) => !r.body.ok).length} | ${Math.round(recRt[0])} | ${pct(recRt, 50)} | ${pct(recRt, 95)} | sim ${pct(sim, 50)} | sim ${pct(sim, 95)} |`,
);
console.log(`\nStellar SDK import inside the function: first ${imp[0]} ms, then ${pct(imp.slice(1), 50)} ms (cached)`);
console.log(`record_of result: ${JSON.stringify(rec.at(-1)!.body.record)}`);
const worst = Math.max(...rows.map((r) => Number(r.split("|")[6])), pct(recRt, 95));
console.log(`\nWorst p95 ${worst} ms vs ${BUDGET_MS} ms voice budget: ${worst < BUDGET_MS ? "INSIDE" : "OVER"}`);
