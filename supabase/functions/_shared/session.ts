// plus_session: a short-lived voice session token, bound to one Plus user.
//
//   token = base64url(JSON {v:1, sub:<users.id>, exp:<unix seconds>, nonce}) + "." +
//           base64url(HMAC-SHA256(VOICE_SESSION_SECRET, payload part))
//
// voice-session mints it for the signed-in app user; the app passes it to ElevenLabs as the
// dynamic variable plus_session, and every tool call sends it back. agent-tools trusts the
// user id only after checking the signature (constant time) and the expiry.
// Fails closed: no secret, no tokens. Never log a token.

export const SESSION_TTL_SECS = 15 * 60;
const MIN_SECRET_LENGTH = 32;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function sign(secret: string, data: string): Promise<Uint8Array> {
  if (!secret || secret.length < MIN_SECRET_LENGTH) throw new Error("VOICE_SESSION_SECRET is not set");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export interface SessionClaims {
  v: 1;
  sub: string;
  exp: number;
  nonce: string;
}

export async function mintSession(
  userId: string,
  secret: string,
  opts: { now?: number; ttlSecs?: number } = {},
): Promise<{ token: string; expiresAt: number }> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const exp = now + (opts.ttlSecs ?? SESSION_TTL_SECS);
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = b64url(enc.encode(JSON.stringify({ v: 1, sub: userId, exp, nonce } satisfies SessionClaims)));
  return { token: `${payload}.${b64url(await sign(secret, payload))}`, expiresAt: exp };
}

export type SessionCheck = { ok: true; userId: string; exp: number } | { ok: false; error: "invalid" | "expired" };

export async function verifySession(token: unknown, secret: string, now = Math.floor(Date.now() / 1000)): Promise<SessionCheck> {
  if (typeof token !== "string" || token.length > 512) return { ok: false, error: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: "invalid" };
  let given: Uint8Array;
  try {
    given = fromB64url(parts[1]);
  } catch {
    return { ok: false, error: "invalid" };
  }
  if (!equal(given, await sign(secret, parts[0]))) return { ok: false, error: "invalid" };
  let claims: SessionClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
  } catch {
    return { ok: false, error: "invalid" };
  }
  if (claims.v !== 1 || typeof claims.sub !== "string" || !Number.isInteger(claims.exp)) {
    return { ok: false, error: "invalid" };
  }
  if (claims.exp <= now) return { ok: false, error: "expired" };
  return { ok: true, userId: claims.sub, exp: claims.exp };
}

/** True when the body carries a plus_session worth checking ("" or an unfilled placeholder is not). */
export function hasSessionToken(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value !== "none" && !value.startsWith("{{");
}
