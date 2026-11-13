// Piece 12: who may start a voice conversation (each one spends ElevenLabs credits).
//
//   VOICE_MODE               off | presenter | on. Missing or unknown: presenter.
//     off        nobody gets a signed URL (the emergency stop)
//     presenter  only a device unlocked for presenting (the staff login, or the presenter code)
//     on         everyone signed in (the behaviour before piece 12)
//   VOICE_PRESENTER_CODE     the presenter code (checked here in constant time; never logged)
//   VOICE_DAILY_SESSION_CAP  new conversations per Lagos day, for everyone together (default 40)
//
// A presenter unlock is a signed token on the device: { sub: "pr:<presenter_unlocks.id>", exp } with
// HMAC-SHA256 under a key derived from VOICE_SESSION_SECRET, so it can never pass as a plus_session
// (and a plus_session never passes as an unlock). Only the row id is kept; the token never is.
import { mintSession, verifySession } from "./session.ts";

export type VoiceMode = "off" | "presenter" | "on";
export const PRESENTER_TTL_SECS = 7 * 24 * 60 * 60;
export const DEFAULT_DAILY_CAP = 40;

declare const Deno: { env: { get(name: string): string | undefined } } | undefined;
const env = (k: string) => (typeof Deno !== "undefined" ? Deno.env.get(k) : undefined);

export function voiceMode(): VoiceMode {
  return voiceModeFrom(env("VOICE_MODE"));
}

export function voiceModeFrom(raw: string | undefined): VoiceMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "off" || v === "on" ? v : "presenter";
}

export function dailyCap(): number {
  return dailyCapFrom(env("VOICE_DAILY_SESSION_CAP"));
}

export function dailyCapFrom(raw: string | undefined): number {
  const n = Number((raw ?? "").trim());
  return Number.isInteger(n) && n >= 0 && n <= 10_000 && (raw ?? "").trim() !== "" ? n : DEFAULT_DAILY_CAP;
}

const presenterKey = (secret: string) => (secret ? `${secret}:presenter-unlock:v1` : "");

export async function mintPresenterToken(unlockId: string, secret: string, now?: number) {
  return await mintSession(`pr:${unlockId}`, presenterKey(secret), { ttlSecs: PRESENTER_TTL_SECS, now });
}

/** The presenter_unlocks id inside a valid, unexpired presenter token; null otherwise. */
export async function presenterUnlockId(token: unknown, secret: string, now?: number): Promise<string | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 600 || !secret) return null;
  const check = await verifySession(token, presenterKey(secret), now);
  if (!check.ok || !check.userId.startsWith("pr:")) return null;
  const id = check.userId.slice(3);
  return /^[0-9a-f-]{36}$/.test(id) ? id : null;
}

const enc = new TextEncoder();
async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/**
 * The typed code against VOICE_PRESENTER_CODE, in constant time (both sides hashed first, so the
 * comparison never depends on where they differ or on their lengths). No code set: always false.
 */
export async function presenterCodeMatches(typed: unknown, expected: string | undefined = env("VOICE_PRESENTER_CODE")): Promise<boolean> {
  const want = (expected ?? "").trim();
  if (want.length < 6 || typeof typed !== "string" || typed.length > 200) return false;
  const [a, b] = await Promise.all([digest(typed.trim()), digest(want)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * The caller's address for rate limits. Supabase's edge sits behind Cloudflare: cf-connecting-ip is
 * set by Cloudflare and can't be chosen by the client; the first x-forwarded-for entry can, so it is
 * never used (the last one is the closest proxy's view).
 */
export function clientAddress(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const xff = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff.at(-1) ?? req.headers.get("x-real-ip")?.trim() ?? "unknown";
}

/** A keyed hash of the address (never the address itself in a table). */
export async function addressHash(req: Request, salt: string): Promise<string> {
  const d = await digest(`${salt}:addr:${clientAddress(req)}`);
  return Array.from(d.slice(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
}
