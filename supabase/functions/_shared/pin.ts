// PINs: set and verify, with lockout.
//
// pin_hash = HMAC-SHA256(PIN_PEPPER, salt || pin), hex; salt is 16 random bytes (hex).
// The pepper lives only in Supabase secrets, so a leaked user_credentials table alone
// cannot be brute-forced. 3 wrong PINs lock the user out for 15 minutes.
// Never log a PIN, never store it, never pass it to the agent or into tool_calls.

declare const Deno: { env: { get(name: string): string | undefined } } | undefined;

export const MAX_FAILED_ATTEMPTS = 3;
export const LOCK_MS = 15 * 60 * 1000;
/** Piece 12: a guest (public test account) is locked out for 1 minute instead. */
export const GUEST_LOCK_MS = 60 * 1000;
const PIN_RE = /^[0-9]{4,6}$/;

export interface PinCredential {
  pin_hash: string;
  pin_salt: string;
  failed_attempts: number;
  locked_until: string | null;
}

export type PinOutcome =
  | { ok: true; outcome: "ok" }
  | { ok: false; outcome: "wrong"; attemptsLeft: number }
  | { ok: false; outcome: "locked"; lockedUntil: string }
  | { ok: false; outcome: "not_set" };

function pepper(): string {
  const value = typeof Deno !== "undefined" ? Deno.env.get("PIN_PEPPER") : undefined;
  if (!value) throw new Error("PIN_PEPPER is not set");
  return value;
}

const enc = new TextEncoder();
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function isValidPin(pin: string): boolean {
  return PIN_RE.test(pin);
}

/** HMAC-SHA256(pepper, salt bytes || pin bytes), hex. */
export async function hashPin(pin: string, saltHex: string, pepperValue: string = pepper()): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(pepperValue), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const salt = fromHex(saltHex);
  const pinBytes = enc.encode(pin);
  const msg = new Uint8Array(salt.length + pinBytes.length);
  msg.set(salt);
  msg.set(pinBytes, salt.length);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, msg)));
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** New credential row values for a PIN (fresh salt, attempts reset). */
export async function newPinCredential(
  pin: string,
  pepperValue?: string,
): Promise<Pick<PinCredential, "pin_hash" | "pin_salt" | "failed_attempts" | "locked_until">> {
  if (!isValidPin(pin)) throw new Error("PIN must be 4 to 6 digits");
  const pin_salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  return { pin_hash: await hashPin(pin, pin_salt, pepperValue), pin_salt, failed_attempts: 0, locked_until: null };
}

/**
 * Pure decision for one PIN attempt: the outcome plus the counters to store.
 * `update` is null when nothing must change (locked, or a correct PIN with no failures recorded).
 */
export async function checkPin(
  cred: PinCredential,
  pin: string,
  now: Date = new Date(),
  pepperValue?: string,
  lockMs: number = LOCK_MS,
): Promise<{ result: PinOutcome; update: Pick<PinCredential, "failed_attempts" | "locked_until"> | null }> {
  if (cred.locked_until && new Date(cred.locked_until).getTime() > now.getTime()) {
    return { result: { ok: false, outcome: "locked", lockedUntil: cred.locked_until }, update: null };
  }
  // A lock that has run out starts a fresh count.
  const failed = cred.locked_until ? 0 : cred.failed_attempts;
  const ok = isValidPin(pin) && constantTimeEqual(await hashPin(pin, cred.pin_salt, pepperValue), cred.pin_hash);
  if (ok) {
    const dirty = cred.failed_attempts !== 0 || cred.locked_until !== null;
    return { result: { ok: true, outcome: "ok" }, update: dirty ? { failed_attempts: 0, locked_until: null } : null };
  }
  const attempts = failed + 1;
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    const lockedUntil = new Date(now.getTime() + lockMs).toISOString();
    return {
      result: { ok: false, outcome: "locked", lockedUntil },
      update: { failed_attempts: 0, locked_until: lockedUntil },
    };
  }
  return {
    result: { ok: false, outcome: "wrong", attemptsLeft: MAX_FAILED_ATTEMPTS - attempts },
    update: { failed_attempts: attempts, locked_until: null },
  };
}

// ---------------------------------------------------------------------------
// Database helpers (service-role supabase-js client)
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
type Db = any;

/** Set or replace a user's PIN. */
export async function setPin(db: Db, userId: string, pin: string): Promise<void> {
  const cred = await newPinCredential(pin);
  const { error } = await db.from("user_credentials").upsert({ user_id: userId, ...cred });
  if (error) throw new Error(`setPin failed: ${error.message}`);
}

/**
 * Verify a PIN and record the attempt. The counter update is conditional on the values
 * read, so two concurrent attempts cannot both be counted from the same starting point;
 * on a conflict the attempt is re-evaluated against the fresh row.
 */
export async function verifyPin(db: Db, userId: string, pin: string, now: Date = new Date(), lockMs: number = LOCK_MS): Promise<PinOutcome> {
  for (let i = 0; i < 3; i++) {
    const { data: cred, error } = await db
      .from("user_credentials")
      .select("pin_hash, pin_salt, failed_attempts, locked_until")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(`verifyPin read failed: ${error.message}`);
    if (!cred) return { ok: false, outcome: "not_set" };

    const { result, update } = await checkPin(cred as PinCredential, pin, now, undefined, lockMs);
    if (!update) return result;

    let q = db.from("user_credentials").update(update).eq("user_id", userId).eq("failed_attempts", cred.failed_attempts);
    q = cred.locked_until === null ? q.is("locked_until", null) : q.eq("locked_until", cred.locked_until);
    const { data: rows, error: upErr } = await q.select("user_id");
    if (upErr) throw new Error(`verifyPin update failed: ${upErr.message}`);
    if (rows && rows.length === 1) return result;
    // Another attempt changed the row first: evaluate again.
  }
  throw new Error("verifyPin: too much contention");
}
