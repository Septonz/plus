// Benchmark: N sequential submit + confirm round trips against one Stellar endpoint (RPC or
// Horizon), from a throwaway friendbot-funded testnet account. Each round trip sends a
// one-operation classic transaction (bump sequence, a no-op) and polls until it is in a
// closed ledger. Used by scripts/bench-rpc.ts (local) and the temporary rpc-bench function.
import { StellarSdk, txHashHex } from "./stellar.ts";

const { Keypair, TransactionBuilder, Operation, Account, rpc, Horizon, BASE_FEE } = StellarSdk;
const PASSPHRASE = "Test SDF Network ; September 2015";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

export type BenchResult = {
  url: string;
  kind: "rpc" | "horizon";
  ok: number;
  failed: number;
  send_ms: number[]; // sendTransaction (or Horizon async submit) latency
  get_ms: number[]; // single getTransaction latency
  total_ms: number[]; // send until confirmed SUCCESS
  errors: string[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Fail a hung request after `ms` instead of waiting forever. */
const within = <T>(p: Promise<T>, ms = 10_000): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`no answer in ${ms} ms`)), ms))]);

export function stats(xs: number[]) {
  if (xs.length === 0) return { n: 0, p50: NaN, p90: NaN, min: NaN, max: NaN, mean: NaN };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: q(0.5), p90: q(0.9), min: s[0], max: s[s.length - 1], mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
}

export async function bench(url: string, kind: "rpc" | "horizon", n: number, pollMs = 250): Promise<BenchResult> {
  const out: BenchResult = { url, kind, ok: 0, failed: 0, send_ms: [], get_ms: [], total_ms: [], errors: [] };
  const kp = Keypair.random();
  const fb = await within(fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`), 30_000);
  if (!fb.ok) throw new Error(`friendbot ${fb.status}`);
  const horizon = new Horizon.Server(HORIZON_URL);
  const acct = await horizon.loadAccount(kp.publicKey());
  let seq = BigInt(acct.sequence);
  const server = kind === "rpc" ? new rpc.Server(url) : null;

  for (let i = 0; i < n; i++) {
    const tx = new TransactionBuilder(new Account(kp.publicKey(), String(seq)), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
      .setTimeout(60)
      .build();
    tx.sign(kp);
    const hash = txHashHex(tx);
    const t0 = performance.now();
    try {
      if (server) {
        const sent = await within(server.sendTransaction(tx));
        out.send_ms.push(Math.round(performance.now() - t0));
        if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") throw new Error(`send ${sent.status}`);
        for (;;) {
          const g0 = performance.now();
          const r = await within(server.getTransaction(hash));
          out.get_ms.push(Math.round(performance.now() - g0));
          if (r.status === "SUCCESS") break;
          if (r.status === "FAILED") throw new Error("FAILED");
          if (performance.now() - t0 > 60_000) throw new Error("timeout");
          await sleep(pollMs);
        }
      } else {
        const res = await within(fetch(`${url}/transactions_async`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ tx: tx.toXDR() }),
        }));
        out.send_ms.push(Math.round(performance.now() - t0));
        const body = await res.json();
        if (body.tx_status !== "PENDING" && body.tx_status !== "DUPLICATE") throw new Error(`async ${body.tx_status}`);
        for (;;) {
          const g0 = performance.now();
          const r = await within(fetch(`${url}/transactions/${hash}`));
          out.get_ms.push(Math.round(performance.now() - g0));
          if (r.status === 200) {
            const t = await r.json();
            if (!t.successful) throw new Error("FAILED");
            break;
          }
          if (performance.now() - t0 > 60_000) throw new Error("timeout");
          await sleep(pollMs);
        }
      }
      out.total_ms.push(Math.round(performance.now() - t0));
      out.ok++;
      seq++;
    } catch (err) {
      out.failed++;
      if (out.failed > 5) {
        out.errors.push("gave up after 6 failures");
        break;
      }
      out.errors.push(err instanceof Error ? err.message : String(err));
      // Resync the sequence number before trying again.
      seq = BigInt((await horizon.loadAccount(kp.publicKey())).sequence);
    }
  }
  return out;
}
