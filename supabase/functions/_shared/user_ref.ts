// user_ref: the only on-chain identifier for people who are not on Stellar.
//
// user_ref = HMAC-SHA256(USER_REF_SECRET, normalized phone number)
//
// Keyed with a server-only secret, so nobody without it can link a hash to a
// phone number (a plain sha256 of a phone number is trivially brute-forced).
// Never put the phone number itself, or this secret, on-chain or in logs.
// Fails closed: throws if USER_REF_SECRET is missing.
//
// Demo users in scripts/seed.ts are the exception: sha256("plus-demo:<name>").

declare const Deno: { env: { get(name: string): string | undefined } } | undefined;

function secret(): string {
  const value = typeof Deno !== "undefined" ? Deno.env.get("USER_REF_SECRET") : undefined;
  if (!value) throw new Error("USER_REF_SECRET is not set");
  return value;
}

/** Normalize to E.164 digits with a leading "+", e.g. "+91 98765-43210" -> "+919876543210". */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!trimmed.startsWith("+") || digits.length < 8 || digits.length > 15) {
    throw new Error("phone must be in international format, e.g. +919876543210");
  }
  return `+${digits}`;
}

let keyPromise: Promise<CryptoKey> | undefined;
function hmacKey(): Promise<CryptoKey> {
  keyPromise ??= crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return keyPromise;
}

/** 32-byte user_ref for a phone number (pass to the contract as BytesN<32>). */
export async function userRef(phone: string): Promise<Uint8Array> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(), new TextEncoder().encode(normalizePhone(phone)));
  return new Uint8Array(mac);
}

/** Hex form of userRef, for Postgres columns and contract CLI calls. */
export async function userRefHex(phone: string): Promise<string> {
  return Array.from(await userRef(phone), (b) => b.toString(16).padStart(2, "0")).join("");
}
