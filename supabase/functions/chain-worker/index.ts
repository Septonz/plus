// chain-worker: drains chain_outbox to Stellar.
//
// One queue per signing account (partner, funmi, agent_ng, ...). Queues run in parallel; within
// an account, one transaction at a time (oldest first), so sequence numbers never collide. A lease
// in chain_signers keeps one worker per account across overlapping runs.
//
//   Classic operations (payment, claimable balances) -> Horizon (async submit, poll by hash).
//   Contract calls (attest, group_record, contract)  -> RPC (simulate, send, poll by hash),
//                                                        STELLAR_RPC_URL first, the SDF default as fallback.
//
// For each row:
//   1. A row left "submitted" by an earlier run is looked up by its saved hash first. It is only
//      rebuilt once the network has provably not included it and its time bound has passed.
//   2. Build, (simulate), sign; save tx_hash BEFORE sending. Never resend blindly: the same signed
//      envelope is only resent after a lookup by hash found nothing.
//   3. Poll every second (ledgers close about every 5 s) until it is in a closed ledger.
//   4. SUCCESS -> done (+ transactions.chain_tx_hash, then rows waiting on it start).
//      Failure -> failed, retried with backoff up to MAX_ATTEMPTS, stays visible with last_error.
//
// Runs every minute (Supabase Cron), after each outbox insert (pg_net trigger) and on kicks from
// agent-tools / payout-sim / agent-api. It answers 202 at once and drains in the background.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { type OutboxRow, operationFor, railOf } from "../_shared/chain-ops.ts";
import { mayRunJob } from "../_shared/cron.ts";
import { refreshBalances } from "../_shared/ng-chain.ts";
import { json, health } from "../_shared/http.ts";
import { isNetworkError, OutcomeUnknownError, StellarSdk, SubmitRejectedError, submitTransaction, txHashHex, withRetry } from "../_shared/stellar.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { rpc, TransactionBuilder, Keypair, Account, Operation } = StellarSdk;
const DEFAULT_RPC = "https://soroban-testnet.stellar.org";
const RPC_URLS = [...new Set([Deno.env.get("STELLAR_RPC_URL") || DEFAULT_RPC, DEFAULT_RPC])];
const HORIZON_URL = Deno.env.get("STELLAR_HORIZON_URL") || "https://horizon-testnet.stellar.org";
const PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") || "Test SDF Network ; September 2015";
const CONTRACT_ID = Deno.env.get("PLUS_CONTRACT_ID") ?? "";
const MAX_ATTEMPTS = 8;
const RUN_BUDGET_MS = 120_000; // stay inside the Edge Function wall-clock limit
const TX_TIMEOUT_SECS = 60;
const POLL_MS = 1000;
const POLL_TIMEOUT_MS = 45_000;
const LEASE_SECS = 60; // extended after every row; a killed run blocks its account for at most this long
const FEE = "1000"; // stroops; testnet

const servers = RPC_URLS.map((u) => new rpc.Server(u));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The secret key for a signing account: Supabase secret PARTNER_SECRET or STELLAR_SECRET_<NAME>. */
function secretFor(signer: string): string | undefined {
  return signer === "partner" ? Deno.env.get("PARTNER_SECRET") : Deno.env.get(`STELLAR_SECRET_${signer.toUpperCase()}`);
}

let partnerKp: InstanceType<typeof Keypair> | null = null;
function partnerKey() {
  const secret = secretFor("partner");
  if (!secret) throw new Error("PARTNER_SECRET is not set (partner pays fees and sponsors reserves)");
  partnerKp ??= Keypair.fromSecret(secret);
  return partnerKp;
}

/** Run an RPC read against the primary, falling back to the next URL on network errors only. */
async function onRpc<T>(fn: (s: InstanceType<typeof rpc.Server>) => Promise<T>): Promise<T> {
  let last: unknown;
  for (const s of servers) {
    try {
      return await withRetry(() => fn(s), { attempts: 2, baseDelayMs: 300 });
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      last = err;
    }
  }
  throw last;
}

// --- Horizon (classic) ------------------------------------------------------------------------

type HorizonTx = { status: "SUCCESS" | "FAILED" | "NOT_FOUND" };

async function horizonGet(hash: string): Promise<HorizonTx> {
  const res = await withRetry(() => fetch(`${HORIZON_URL}/transactions/${hash}`), { attempts: 3, baseDelayMs: 300 });
  if (res.status === 404) {
    await res.body?.cancel();
    return { status: "NOT_FOUND" };
  }
  if (!res.ok) throw new Error(`horizon ${res.status}`);
  const t = await res.json();
  return { status: t.successful ? "SUCCESS" : "FAILED" };
}

/** Async submit + poll every second. Same rules as the RPC helper: never resend before a lookup. */
async function horizonSubmit(tx: { toXDR(): string; hash(): Uint8Array }): Promise<HorizonTx> {
  const hash = txHashHex(tx);
  const xdrB64 = tx.toXDR();
  for (let attempt = 1; attempt <= 3; attempt++) {
    let body: { tx_status?: string; error_result_xdr?: string } | null = null;
    try {
      const res = await fetch(`${HORIZON_URL}/transactions_async`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ tx: xdrB64 }),
      });
      body = await res.json();
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      // Outcome unknown: look it up first; only resend the same envelope if nobody has seen it.
      const seen = await pollHorizon(hash, 3000);
      if (seen.status !== "NOT_FOUND") return seen;
      continue;
    }
    const st = body?.tx_status;
    if (st === "ERROR") throw new SubmitRejectedError(hash, { status: "ERROR", errorResult: body?.error_result_xdr });
    if (st === "TRY_AGAIN_LATER") {
      await sleep(1000 * attempt);
      continue;
    }
    // PENDING or DUPLICATE: in the network's hands.
    const res = await pollHorizon(hash, POLL_TIMEOUT_MS);
    if (res.status === "NOT_FOUND") throw new OutcomeUnknownError(hash);
    return res;
  }
  const last = await horizonGet(hash);
  if (last.status === "NOT_FOUND") throw new OutcomeUnknownError(hash);
  return last;
}

async function pollHorizon(hash: string, timeoutMs: number): Promise<HorizonTx> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await horizonGet(hash);
    if (r.status !== "NOT_FOUND" || Date.now() > deadline) return r;
    await sleep(POLL_MS);
  }
}

async function horizonSequence(pub: string): Promise<bigint> {
  const res = await withRetry(() => fetch(`${HORIZON_URL}/accounts/${pub}`), { attempts: 3, baseDelayMs: 300 });
  if (!res.ok) throw new Error(`horizon account ${res.status}`);
  return BigInt((await res.json()).sequence);
}

// --- Outbox bookkeeping ------------------------------------------------------------------------

async function update(id: number, patch: Record<string, unknown>) {
  const { error } = await db.from("chain_outbox").update(patch).eq("id", id);
  if (error) throw new Error(`outbox update ${id}: ${error.message}`);
}

const backoffMs = (attempts: number) => Math.min(30 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1));

async function markDone(row: OutboxRow, hash: string) {
  await update(row.id, { status: "done", tx_hash: hash, done_at: new Date().toISOString(), last_error: null });
  const txId = row.args.transaction_id ? String(row.args.transaction_id) : null;
  const refresh = new Set<string>(Array.isArray(row.args.refresh_user_ids) ? (row.args.refresh_user_ids as string[]) : []);
  let stellarTx = false;
  if (txId) {
    const { data: t } = await db.from("transactions").select("user_id, rail").eq("id", txId).maybeSingle();
    if (t?.rail === "stellar") {
      stellarTx = true;
      refresh.add(t.user_id as string);
    }
  }
  // Nigeria: the balance cache first, then the tick (so "available" never counts money twice).
  if (refresh.size > 0) {
    try {
      const ms = await refreshBalances(db, [...refresh]);
      console.log(`balances refreshed for ${refresh.size} user(s), horizon ${ms.join("/")} ms`);
    } catch (err) {
      console.error("balance refresh failed (scheduler retries every minute)", err instanceof Error ? err.message : err);
    }
  }
  if (txId) {
    await db.from("transactions").update(stellarTx ? { chain_tx_hash: hash, tx_hash: hash, status: "completed" } : { chain_tx_hash: hash })
      .eq("id", txId);
  }
  // Rows waiting on this one (possibly on other accounts) can start now.
  const { data: next } = await db.from("chain_outbox").select("signer").eq("after_id", row.id).neq("status", "done");
  for (const r of next ?? []) wake(r.signer as string);
}

async function markFailed(row: OutboxRow, attempts: number, message: string, hash: string | null = null) {
  await update(row.id, {
    status: "failed",
    attempts,
    last_error: message.slice(0, 500),
    next_attempt_at: new Date(Date.now() + backoffMs(attempts)).toISOString(),
    ...(hash ? { tx_hash: hash } : {}),
  });
  // Out of retries: the money never moved. The Stellar transaction row says so (no tick, no spend).
  if (attempts >= MAX_ATTEMPTS && row.args.transaction_id) {
    await db.from("transactions").update({ status: "failed" }).eq("id", String(row.args.transaction_id)).eq("rail", "stellar").eq("status", "pending");
  }
}

async function lookup(row: OutboxRow): Promise<HorizonTx> {
  if (railOf(row.kind) === "horizon") return await horizonGet(row.tx_hash!);
  return { status: (await onRpc((s) => s.getTransaction(row.tx_hash!))).status as HorizonTx["status"] };
}

/** A row from an earlier run whose outcome we don't know yet. Returns true when resolved. */
async function resolveSubmitted(row: OutboxRow): Promise<boolean> {
  const res = await lookup(row);
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
  return false; // may still land: send nothing else from this account yet
}

// --- One account's queue -------------------------------------------------------------------------

type Stats = { signer: string; resolved: number; done: number; failed: number; blocked?: string; ms: number[] };

async function submitRow(kp: InstanceType<typeof Keypair>, seq: { next: bigint | null }, row: OutboxRow, stats: Stats) {
  const attempts = row.attempts + 1;
  const rail = railOf(row.kind);
  const t0 = Date.now();
  let hash: string | null = null;
  try {
    if (seq.next === null) {
      seq.next = rail === "horizon"
        ? await horizonSequence(kp.publicKey())
        : BigInt((await onRpc((s) => s.getAccount(kp.publicKey()))).sequenceNumber());
    }
    const partner = row.signer === "partner" ? kp : partnerKey();
    // A claimable balance needs a reserve; accounts without XLM (Funmi) get it sponsored by partner.
    const sponsor = row.kind === "claimable_create" && row.signer !== "partner";
    const b = new TransactionBuilder(new Account(kp.publicKey(), seq.next.toString()), { fee: FEE, networkPassphrase: PASSPHRASE })
      .setTimeout(TX_TIMEOUT_SECS);
    if (sponsor) b.addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: kp.publicKey(), source: partner.publicKey() }));
    b.addOperation(operationFor(row, CONTRACT_ID));
    if (sponsor) b.addOperation(Operation.endSponsoringFutureReserves({}));
    const built = b.build();
    const inner = rail === "rpc" ? await onRpc((s) => s.prepareTransaction(built)) : built; // simulation: contract errors throw here
    inner.sign(kp);
    if (sponsor) inner.sign(partner);
    // Plus pays the network fee for every account other than partner (fee bump). The fee source's
    // sequence number is not used, so this never interferes with partner's own queue.
    const tx = row.signer === "partner"
      ? inner
      : (() => {
        const fb = TransactionBuilder.buildFeeBumpTransaction(partner, (BigInt(inner.fee) + 1000n).toString(), inner, PASSPHRASE);
        fb.sign(partner);
        return fb;
      })();
    hash = txHashHex(tx);
    const result = row.kind === "claimable_create" ? { balance_id: inner.getClaimableBalanceId(sponsor ? 1 : 0) } : null;
    // Save the hash (and anything the transaction will produce) BEFORE sending.
    await update(row.id, {
      status: "submitted",
      attempts,
      tx_hash: hash,
      tx_valid_until: new Date(Number(inner.timeBounds?.maxTime ?? 0) * 1000).toISOString(),
      submitted_at: new Date().toISOString(),
      last_error: null,
      ...(result ? { result } : {}),
    });
    let res: { status: string };
    if (rail === "horizon") res = await horizonSubmit(tx);
    else {
      try {
        res = await submitTransaction(servers[0], tx, { pollIntervalMs: POLL_MS, pollTimeoutMs: POLL_TIMEOUT_MS });
      } catch (err) {
        // Primary RPC unreachable: hand the SAME signed envelope to the fallback (same hash,
        // same sequence number, so it can never apply twice).
        if (!isNetworkError(err) || servers.length < 2) throw err;
        res = await submitTransaction(servers[1], tx, { pollIntervalMs: POLL_MS, pollTimeoutMs: POLL_TIMEOUT_MS });
      }
    }
    if (res.status === "SUCCESS") {
      seq.next = seq.next + 1n;
      await markDone(row, hash);
      stats.done++;
      stats.ms.push(Date.now() - t0);
    } else {
      seq.next = null; // a failed transaction still used its sequence number; reload to be safe
      await markFailed(row, attempts, `transaction ${hash} ${res.status}`, hash);
      stats.failed++;
    }
  } catch (err) {
    seq.next = null;
    if (err instanceof OutcomeUnknownError) throw err; // stays "submitted": stop this queue
    const msg = err instanceof SubmitRejectedError ? `rejected: ${JSON.stringify(err.result.errorResult ?? err.result.status)}`
      : err instanceof Error ? err.message : String(err);
    await markFailed(row, attempts, msg);
    stats.failed++;
  }
}

async function nextRow(signer: string): Promise<OutboxRow | null> {
  const { data, error } = await db.from("chain_outbox").select("*").eq("signer", signer)
    .in("status", ["queued", "failed"]).lt("attempts", MAX_ATTEMPTS).lte("next_attempt_at", new Date().toISOString())
    .order("id").limit(1).maybeSingle();
  if (error) throw error;
  return (data as OutboxRow) ?? null;
}

async function drainSigner(signer: string, started: number): Promise<Stats> {
  const stats: Stats = { signer, resolved: 0, done: 0, failed: 0, ms: [] };
  const secret = secretFor(signer);
  if (!secret) {
    stats.blocked = "no secret configured";
    return stats;
  }
  const holder = crypto.randomUUID();
  const { data: leased } = await db.rpc("chain_lease", { p_signer: signer, p_holder: holder, p_secs: LEASE_SECS });
  if (!leased) {
    stats.blocked = "leased by another run";
    return stats;
  }
  const kp = Keypair.fromSecret(secret);
  const seq = { next: null as bigint | null };
  try {
    // 1. Earlier submissions first: never send a new transaction while one may be in flight.
    const { data: inFlight } = await db.from("chain_outbox").select("*").eq("signer", signer).eq("status", "submitted").order("id");
    for (const row of (inFlight ?? []) as OutboxRow[]) {
      if (!(await resolveSubmitted(row))) {
        stats.blocked = `waiting on ${row.tx_hash}`;
        return stats;
      }
      stats.resolved++;
    }
    // 2. Then the queue, oldest first, one at a time.
    while (Date.now() - started < RUN_BUDGET_MS) {
      const row = await nextRow(signer);
      if (!row) break;
      if (row.after_id) {
        const { data: dep } = await db.from("chain_outbox").select("status").eq("id", row.after_id).single();
        if (dep?.status !== "done") {
          stats.blocked = `row ${row.id} waits for row ${row.after_id}`;
          break; // strict order within an account; markDone of the dependency wakes us
        }
      }
      try {
        await submitRow(kp, seq, row, stats);
      } catch (err) {
        if (err instanceof OutcomeUnknownError) {
          stats.blocked = `outcome unknown: ${err.hash}`;
          break;
        }
        throw err;
      }
      await db.rpc("chain_lease", { p_signer: signer, p_holder: holder, p_secs: LEASE_SECS }); // extend
    }
    return stats;
  } catch (err) {
    console.error(`chain-worker ${signer} failed`, err instanceof Error ? err.message : err);
    return stats;
  } finally {
    await db.rpc("chain_release", { p_signer: signer, p_holder: holder });
  }
}

// --- Scheduling within one invocation -----------------------------------------------------------

const running = new Map<string, Promise<Stats>>();
const again = new Set<string>();
const all: Promise<Stats>[] = [];
let runStarted = Date.now();

/** Start (or re-run after it finishes) the drain for one account. */
function wake(signer: string) {
  if (running.has(signer)) {
    again.add(signer);
    return;
  }
  const p = (async () => {
    let s: Stats;
    do {
      again.delete(signer);
      s = await drainSigner(signer, runStarted);
    } while (again.has(signer) && Date.now() - runStarted < RUN_BUDGET_MS);
    running.delete(signer);
    return s;
  })();
  running.set(signer, p);
  all.push(p);
}

async function dueSigners(only?: string): Promise<string[]> {
  if (only) return [only];
  const { data, error } = await db.from("chain_outbox").select("signer")
    .or(`status.in.(queued,submitted),and(status.eq.failed,attempts.lt.${MAX_ATTEMPTS})`).limit(1000);
  if (error) throw error;
  return [...new Set((data ?? []).map((r) => r.signer as string))];
}

// Provided by the Supabase Edge Runtime.
declare const EdgeRuntime: { waitUntil(p: PromiseLike<unknown>): void };

Deno.serve(async (req) => {
  const up = health(req, "chain-worker");
  if (up) return up;
  if (!(await mayRunJob(req, db))) return json({ error: "unauthorized" }, 401);
  if (!CONTRACT_ID) return json({ error: "not_configured" }, 503);
  let only: string | undefined;
  try {
    const body = await req.json();
    if (typeof body?.signer === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(body.signer)) only = body.signer;
  } catch {
    // no body: drain every account with work
  }
  const signers = await dueSigners(only);
  if (running.size === 0) runStarted = Date.now();
  for (const s of signers) wake(s);

  // Callers (cron via pg_net, the outbox trigger, agent-tools) don't wait: answer now and drain
  // in the background, so a caller hanging up never stops a run halfway.
  EdgeRuntime.waitUntil((async () => {
    // Wait for every drain, including ones woken later by markDone.
    for (let i = 0; i < all.length; i++) await all[i];
    const results = await Promise.all(all.splice(0));
    if (results.length) console.log(`chain-worker run: ${JSON.stringify(results)} in ${Date.now() - runStarted} ms`);
  })());
  return json({ ok: true, signers }, 202);
});
