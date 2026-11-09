// pnpm bench:confirm [contract|payment] [runs] — time from her Yes until the transaction is in a
// closed ledger and the app's tick can show (chain_outbox row done, transactions.chain_tx_hash set).
//
//   contract: Selvi (India) prepares ₹10 to the medical shop and taps Yes; the attest is a Soroban
//             contract call (RPC).
//   payment:  a classic payment on the partner's queue (Horizon). Until the Nigeria tools exist this
//             enqueues the row directly, so it measures enqueue -> on-chain without the Yes request.
//
// One run at a time, with an empty queue, so it measures latency rather than queueing. Polls the
// database every 200 ms. Prints no secrets. Needs `pnpm seed:db` first.
import { createClient } from "@supabase/supabase-js";
import { adminClient, loadLocalEnv } from "./lib/supabase-admin.ts";

loadLocalEnv();
const { db: admin, url } = adminClient();
const mode = process.argv[2] === "payment" ? "payment" : "contract";
const runs = Number(process.argv[3] ?? 3);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PARTNER = "GCHDENOIJ5JFA3JU3OPW3LZSLHR57HCOHA7ZYQSRYG6MHHOFSAM4CWWZ";

async function idle() {
  for (let i = 0; i < 120; i++) {
    const { count } = await admin.from("chain_outbox").select("id", { count: "exact", head: true }).in("status", ["queued", "submitted"]);
    if (!count) return;
    await sleep(1000);
  }
  throw new Error("outbox did not drain");
}

async function waitDone(id: number, t0: number): Promise<{ ms: number; hash: string; db_ms: number }> {
  for (;;) {
    const { data } = await admin.from("chain_outbox").select("status, tx_hash, done_at, last_error, attempts").eq("id", id).single();
    if (data?.status === "done") return { ms: Date.now() - t0, hash: data.tx_hash, db_ms: Date.parse(data.done_at) - t0 };
    if (data?.status === "failed") throw new Error(`row ${id} failed: ${data.last_error}`);
    if (Date.now() - t0 > 180_000) throw new Error(`row ${id} still ${data?.status} after 3 min`);
    await sleep(200);
  }
}

async function kick() {
  await fetch(`${url}/functions/v1/chain-worker`, { method: "POST", headers: { "x-plus-secret": process.env.AGENT_SHARED_SECRET! } }).then((r) => r.body?.cancel());
}

async function main() {
  const results: number[] = [];
  let tool: ((name: string, body: Record<string, unknown>) => Promise<Record<string, any>>) | null = null;
  if (mode === "contract") {
    const client = createClient(url, process.env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    const { data, error } = await client.auth.signInWithPassword({ email: "demo-selvi@example.com", password: process.env.VITE_DEMO_LOGIN_PASSWORD! });
    if (error) throw error;
    const token = data.session.access_token;
    tool = async (name, body) => {
      const r = await fetch(`${url}/functions/v1/agent-tools/${name}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      return await r.json() as Record<string, any>;
    };
  }
  console.log(`bench:confirm ${mode}, ${runs} runs\n`);
  for (let i = 1; i <= runs; i++) {
    await idle();
    let id: number;
    let t0: number;
    if (tool) {
      const p = await tool("prepare_pay", { payee: "medical shop", amount: 10 });
      if (!p.ok) throw new Error(`prepare_pay: ${p.text}`);
      const before = new Date(Date.now() - 2000).toISOString();
      t0 = Date.now(); // her Yes
      const c = await tool("confirm_action", { action_id: p.action_id });
      if (c.status !== "done") throw new Error(`confirm: ${c.text}`);
      const { data } = await admin.from("chain_outbox").select("id").like("ref", "attest:%").gte("created_at", before).order("id", { ascending: false }).limit(1).single();
      id = data!.id;
    } else {
      t0 = Date.now();
      const { data, error } = await admin.rpc("chain_enqueue_on", {
        p_signer: "partner", p_kind: "payment", p_ref: `bench:payment:${crypto.randomUUID()}`,
        p_args: { asset: "XLM", to: PARTNER, amount: "1" },
      });
      if (error) throw error;
      id = Number(data);
      await kick(); // agent-tools kicks after every confirm; do the same
    }
    const r = await waitDone(id, t0);
    results.push(r.ms);
    console.log(`  run ${i}: ${(r.ms / 1000).toFixed(1)} s until the app can show the tick (worker done at +${(r.db_ms / 1000).toFixed(1)} s)  https://stellar.expert/explorer/testnet/tx/${r.hash}`);
  }
  const s = [...results].sort((a, b) => a - b);
  console.log(`\n  median ${(s[Math.floor(s.length / 2)] / 1000).toFixed(1)} s, min ${(s[0] / 1000).toFixed(1)} s, max ${(s[s.length - 1] / 1000).toFixed(1)} s`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
