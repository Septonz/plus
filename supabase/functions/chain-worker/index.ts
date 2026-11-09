// chain-worker: drains chain_outbox to the Plus contract, one transaction at a time per signing
// account. Voice tools and app actions never wait for this.
//
// Runs every minute (Supabase Cron) and right after each outbox insert (pg_net trigger, plus a
// kick from agent-tools / payout-sim). A lease in chain_signers keeps one worker per signer, so
// sequence numbers never collide.
//
// For each row:
//   1. A row left "submitted" by an earlier run is looked up by its saved hash first. It is only
//      rebuilt once the network has provably not included it and its time bound has passed.
//   2. Build, simulate (prepareTransaction), sign; save tx_hash BEFORE sending.
//   3. submitTransaction (retry helper: network errors only; looks up by hash before any resend).
//   4. SUCCESS -> done (+ transactions.chain_tx_hash). Failure -> failed, retried with backoff
//      (up to MAX_ATTEMPTS), and stays visible with last_error.
import "@supabase/functions-js/edge-runtime.d.ts";
import { Buffer } from "node:buffer";
import { createClient } from "@supabase/supabase-js";
import { mayRunJob } from "../_shared/cron.ts";
import { json } from "../_shared/http.ts";
import {
  OutcomeUnknownError,
  StellarSdk,
  SubmitRejectedError,
  submitTransaction,
  txHashHex,
  withRetry,
} from "../_shared/stellar.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { rpc, Contract, TransactionBuilder, Keypair, nativeToScVal, xdr, BASE_FEE } = StellarSdk;
const RPC_URL = Deno.env.get("STELLAR_RPC_URL") || "https://soroban-testnet.stellar.org";
const PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") || "Test SDF Network ; September 2015";
const CONTRACT_ID = Deno.env.get("PLUS_CONTRACT_ID") ?? "";
const SIGNER = "partner";
const MAX_ATTEMPTS = 8;
const RUN_BUDGET_MS = 100_000; // stay well inside the Edge Function wall-clock limit
const TX_TIMEOUT_SECS = 60;

type Row = {
  id: number;
  kind: "attest" | "group_record";
  args: Record<string, string | number>;
  ref: string;
  status: string;
  attempts: number;
  tx_hash: string | null;
  tx_valid_until: string | null;
};

const ATTEST_KIND: Record<string, number> = { received: 0, saved: 1, paid: 2 };
const bytes32 = (hex: unknown) => {
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/.test(hex)) throw new Error("bad 32-byte hex");
  return xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
};
const i128 = (v: unknown) => nativeToScVal(BigInt(String(v)), { type: "i128" });
const u32 = (v: unknown) => nativeToScVal(Number(v), { type: "u32" });

function operation(row: Row) {
  const c = new Contract(CONTRACT_ID);
  const a = row.args;
  if (row.kind === "attest") {
    const kind = ATTEST_KIND[String(a.kind)];
    if (kind === undefined) throw new Error(`unknown attest kind ${a.kind}`);
    return c.call("attest", bytes32(a.user_ref), u32(kind), i128(a.amount), bytes32(a.payment_ref));
  }
  return c.call("group_record", u32(a.group_id), bytes32(a.member_ref), i128(a.amount), bytes32(a.payment_ref));
}

const backoffMs = (attempts: number) => Math.min(30 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1));

async function update(id: number, patch: Record<string, unknown>) {
  const { error } = await db.from("chain_outbox").update(patch).eq("id", id);
  if (error) throw new Error(`outbox update ${id}: ${error.message}`);
}

async function markDone(row: Row, hash: string) {
  await update(row.id, { status: "done", tx_hash: hash, done_at: new Date().toISOString(), last_error: null });
  if (row.args.transaction_id) {
    await db.from("transactions").update({ chain_tx_hash: hash }).eq("id", String(row.args.transaction_id));
  }
}

async function markFailed(row: Row, attempts: number, message: string, hash: string | null = null) {
  await update(row.id, {
    status: "failed",
    attempts,
    last_error: message.slice(0, 500),
    next_attempt_at: new Date(Date.now() + backoffMs(attempts)).toISOString(),
    ...(hash ? { tx_hash: hash } : {}),
  });
}

/** A row from an earlier run whose outcome we don't know yet. Returns true when resolved. */
async function resolveSubmitted(server: InstanceType<typeof rpc.Server>, row: Row): Promise<boolean> {
  const res = await withRetry(() => server.getTransaction(row.tx_hash!));
  if (res.status === "SUCCESS") {
    await markDone(row, row.tx_hash!);
    return true;
  }
  if (res.status === "FAILED") {
    await markFailed(row, row.attempts, `transaction ${row.tx_hash} failed on-chain`);
    return true;
  }
  // NOT_FOUND: only once its time bound has passed can it never be included; then rebuild.
  const until = row.tx_valid_until ? Date.parse(row.tx_valid_until) : 0;
  if (Date.now() > until + 15_000) {
    await update(row.id, { status: "queued", last_error: `expired unseen: ${row.tx_hash}`, next_attempt_at: new Date().toISOString() });
    return true;
  }
  return false; // still in flight: wait, don't send anything else from this account
}

async function submitRow(server: InstanceType<typeof rpc.Server>, kp: InstanceType<typeof Keypair>, row: Row) {
  const attempts = row.attempts + 1;
  let hash: string | null = null;
  try {
    const account = await withRetry(() => server.getAccount(kp.publicKey()));
    const built = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(operation(row))
      .setTimeout(TX_TIMEOUT_SECS)
      .build();
    const tx = await withRetry(() => server.prepareTransaction(built)); // simulation: contract errors throw here
    tx.sign(kp);
    hash = txHashHex(tx);
    // Save the hash BEFORE sending, so a crash never loses track of it.
    await update(row.id, {
      status: "submitted",
      attempts,
      tx_hash: hash,
      tx_valid_until: new Date(Number(tx.timeBounds?.maxTime ?? 0) * 1000).toISOString(),
      submitted_at: new Date().toISOString(),
      last_error: null,
    });
    const res = await submitTransaction(server, tx, { pollTimeoutMs: 45_000 });
    if (res.status === "SUCCESS") await markDone(row, hash);
    else await markFailed(row, attempts, `transaction ${hash} ${res.status}`, hash);
  } catch (err) {
    if (err instanceof OutcomeUnknownError) return; // stays "submitted": next run looks it up by hash
    const msg = err instanceof SubmitRejectedError ? `rejected by RPC: ${JSON.stringify(err.result.errorResult ?? err.result.status)}`
      : err instanceof Error ? err.message : String(err);
    await markFailed(row, attempts, msg);
  }
}

Deno.serve(async (req) => {
  if (!(await mayRunJob(req, db))) return json({ error: "unauthorized" }, 401);
  const secret = Deno.env.get("PARTNER_SECRET");
  if (!secret || !CONTRACT_ID) return json({ error: "not_configured" }, 503);

  const holder = crypto.randomUUID();
  const { data: leased, error: leaseErr } = await db.rpc("chain_lease", { p_signer: SIGNER, p_holder: holder, p_secs: 150 });
  if (leaseErr) return json({ error: leaseErr.message }, 500);
  if (!leased) return json({ ok: true, skipped: "another worker holds the lease" });

  const started = Date.now();
  const server = new rpc.Server(RPC_URL);
  const kp = Keypair.fromSecret(secret);
  const stats = { resolved: 0, submitted: 0, done: 0, failed: 0, waiting: false };
  try {
    // 1. Earlier submissions first: never send a new transaction while one may be in flight.
    const { data: inFlight } = await db.from("chain_outbox").select("*").eq("signer", SIGNER).eq("status", "submitted").order("id");
    for (const row of (inFlight ?? []) as Row[]) {
      if (!(await resolveSubmitted(server, row))) {
        stats.waiting = true;
        return json({ ok: true, ...stats });
      }
      stats.resolved++;
    }
    // 2. Then the queue, oldest first, one at a time.
    while (Date.now() - started < RUN_BUDGET_MS) {
      const { data: next, error } = await db.from("chain_outbox").select("*").eq("signer", SIGNER)
        .in("status", ["queued", "failed"]).lt("attempts", MAX_ATTEMPTS).lte("next_attempt_at", new Date().toISOString())
        .order("id").limit(1).maybeSingle();
      if (error) throw error;
      if (!next) break;
      await submitRow(server, kp, next as Row);
      stats.submitted++;
      const { data: after } = await db.from("chain_outbox").select("status").eq("id", (next as Row).id).single();
      if (after?.status === "done") stats.done++;
      else if (after?.status === "failed") stats.failed++;
      else break; // outcome unknown: stop until the next run looks it up
      await db.rpc("chain_lease", { p_signer: SIGNER, p_holder: holder, p_secs: 150 }); // extend
    }
    return json({ ok: true, ...stats, ms: Date.now() - started });
  } catch (err) {
    console.error("chain-worker failed", err instanceof Error ? err.message : err);
    return json({ ok: false, error: "internal", ...stats }, 500);
  } finally {
    await db.rpc("chain_release", { p_signer: SIGNER, p_holder: holder });
  }
});
