// pnpm bench:rpc — 20 submit + confirm round trips against each testnet endpoint, in parallel,
// from this machine. Prints p50/p90 for send, getTransaction and send-until-confirmed.
// Throwaway friendbot accounts; no keys are stored. Usage: deno run -A scripts/bench-rpc.ts [n]
import { bench, stats } from "../supabase/functions/_shared/rpc-bench.ts";

const N = Number(Deno.args[0] ?? 20);
const TARGETS: [string, "rpc" | "horizon"][] = [
  ["https://soroban-testnet.stellar.org", "rpc"],
  ["https://soroban-rpc.testnet.stellar.gateway.fm", "rpc"],
  ["https://stellar-soroban-testnet-public.nodies.app", "rpc"],
  ["https://horizon-testnet.stellar.org", "horizon"],
];

console.log(`${N} round trips each, poll every 250 ms\n`);
await Promise.all(TARGETS.map(([u, k]) => bench(u, k, N).catch((e) => ({ url: u, error: String(e) })).then(report)));

function report(r: Awaited<ReturnType<typeof bench>> | { url: string; error: string }) {
  if ("error" in r) {
    console.log(`${r.url}\n  error: ${r.error}\n`);
    return;
  }
  const f = (xs: number[]) => {
    const s = stats(xs);
    return `p50 ${s.p50} ms, p90 ${s.p90} ms, min ${s.min}, max ${s.max}`;
  };
  console.log(`${r.url}  (${r.kind}; ${r.ok} ok, ${r.failed} failed${r.errors.length ? `: ${[...new Set(r.errors)].join(", ")}` : ""})`);
  console.log(`  send            ${f(r.send_ms)}`);
  console.log(`  getTransaction  ${f(r.get_ms)}`);
  console.log(`  until confirmed ${f(r.total_ms)}\n`);
}
