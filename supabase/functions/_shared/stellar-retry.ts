// Network retry + safe transaction submission for Stellar RPC.
// Dependency-free and runtime-agnostic: used by Edge Functions (via stellar.ts)
// and by Node scripts (scripts/seed.ts imports this file directly).
//
// Rules:
// - Only network errors are retried (fetch failed, connection reset, timeouts).
//   Contract errors, bad requests and rejected transactions are never retried.
// - A transaction submission is never retried blindly. If the outcome of
//   sendTransaction is unknown, the transaction is first looked up by its hash;
//   only when the network provably has not seen it is the SAME signed envelope
//   (same hash, same sequence number) sent again, so it can never apply twice.

export interface RetryOptions {
  attempts?: number; // total attempts, default 3
  baseDelayMs?: number; // first backoff, doubled each time, default 500
  label?: string;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const NETWORK_MESSAGE = /fetch failed|network ?error|socket hang up|timed? ?out|connection (reset|refused|closed)|other side closed|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i;

/** True only for transport failures, where the server never gave an answer. */
export function isNetworkError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const x = e as { name?: string; code?: string; message?: string; response?: unknown; cause?: unknown };
    // An HTTP response means the server answered: not a network error.
    if (x.response) return false;
    if (x.code && NETWORK_CODES.has(x.code)) return true;
    if (x.name === "AbortError" || x.name === "TimeoutError") return true;
    if (typeof x.message === "string" && NETWORK_MESSAGE.test(x.message)) return true;
    e = x.cause;
  }
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry `fn` on network errors only, with exponential backoff. Use for reads and simulations. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isNetworkError(err)) throw err;
      const delay = base * 2 ** (attempt - 1);
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}

// Minimal structural types so this file needs no SDK import.
export interface SignedTx {
  hash(): Uint8Array;
}
export interface SendResult {
  status: string; // PENDING | DUPLICATE | TRY_AGAIN_LATER | ERROR
  hash?: string;
  errorResult?: unknown;
}
export interface GetResult {
  status: string; // SUCCESS | FAILED | NOT_FOUND
}
export interface RpcLike<G extends GetResult = GetResult> {
  sendTransaction(tx: never): Promise<SendResult>;
  getTransaction(hash: string): Promise<G>;
}

export class SubmitRejectedError extends Error {
  readonly hash: string;
  readonly result: SendResult;
  constructor(hash: string, result: SendResult) {
    super(`transaction ${hash} rejected by RPC (${result.status})`);
    this.name = "SubmitRejectedError";
    this.hash = hash;
    this.result = result;
  }
}

export class OutcomeUnknownError extends Error {
  readonly hash: string;
  constructor(hash: string) {
    super(`outcome of ${hash} unknown; look it up by hash before doing anything else`);
    this.name = "OutcomeUnknownError";
    this.hash = hash;
  }
}

export function txHashHex(tx: SignedTx): string {
  return Array.from(tx.hash(), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SubmitOptions extends RetryOptions {
  pollIntervalMs?: number; // default 1500
  pollTimeoutMs?: number; // default 60s
}

/** Poll getTransaction (with network retries) until it leaves NOT_FOUND or the timeout passes. */
export async function pollTransaction<G extends GetResult>(
  server: RpcLike<G>,
  hash: string,
  opts: SubmitOptions = {},
): Promise<G> {
  const deadline = Date.now() + (opts.pollTimeoutMs ?? 60_000);
  for (;;) {
    const res = await withRetry(() => server.getTransaction(hash), opts);
    if (res.status !== "NOT_FOUND" || Date.now() > deadline) return res;
    await sleep(opts.pollIntervalMs ?? 1500);
  }
}

/**
 * Submit a signed transaction and wait for its final result (SUCCESS or FAILED).
 * Save `txHashHex(tx)` BEFORE calling this, so a crash never loses track of it.
 *
 * Throws SubmitRejectedError when RPC rejects it (nothing was applied) and
 * OutcomeUnknownError when it still cannot be found; in that case look it up
 * by hash later instead of building a new transaction.
 */
export async function submitTransaction<G extends GetResult>(
  server: RpcLike<G>,
  tx: SignedTx,
  opts: SubmitOptions = {},
): Promise<G> {
  const hash = txHashHex(tx);
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 500;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let sent: SendResult | undefined;
    try {
      sent = await server.sendTransaction(tx as never);
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      // Outcome unknown: the RPC may or may not have received it. Look it up first.
      const seen = await withRetry(() => server.getTransaction(hash), opts);
      if (seen.status !== "NOT_FOUND") return seen.status === "SUCCESS" || seen.status === "FAILED" ? seen : pollTransaction(server, hash, opts);
      // Not seen yet. It may still be in flight, so give it one poll window before resending.
      const later = await pollTransaction(server, hash, { ...opts, pollTimeoutMs: base * 2 ** attempt });
      if (later.status !== "NOT_FOUND") return later;
      opts.onRetry?.(err, attempt, 0);
      continue; // resend the same signed envelope (same hash): it cannot apply twice
    }

    if (sent.status === "ERROR") throw new SubmitRejectedError(hash, sent);
    if (sent.status === "TRY_AGAIN_LATER") {
      // Explicitly not accepted: safe to resend after backing off.
      await sleep(base * 2 ** (attempt - 1));
      continue;
    }
    // PENDING or DUPLICATE: it is in the network's hands.
    const res = await pollTransaction(server, hash, opts);
    if (res.status === "NOT_FOUND") throw new OutcomeUnknownError(hash);
    return res;
  }
  // Last check before giving up.
  const last = await withRetry(() => server.getTransaction(hash), opts);
  if (last.status === "NOT_FOUND") throw new OutcomeUnknownError(hash);
  return last;
}
