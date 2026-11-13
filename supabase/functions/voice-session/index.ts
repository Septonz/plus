// voice-session: starts a voice conversation for the signed-in app user.
//
//   POST /functions/v1/voice-session      Authorization: Bearer <Supabase access token>
//   -> { signed_url, plus_session, expires_at }
//
// 1. Verifies the Supabase login and finds her Plus account (users.auth_user_id).
// 2. Piece 12: checks VOICE_MODE (off | presenter | on; missing = presenter). In presenter mode only
//    a device unlocked for presenting gets a URL (body.presenter_token, see _shared/voice-mode.ts);
//    then today's budget (VOICE_DAILY_SESSION_CAP, default 40, all callers together).
// 3. Gets a signed conversation URL for her market's private ElevenLabs agent (valid 15 minutes).
// 4. Mints plus_session: an HMAC token bound to her user id, expiring in 15 minutes.
//
//   POST /functions/v1/voice-session/status  -> { configured, available, mode, reason }  (no ElevenLabs call)
// The app asks this first. configured=false: her market's agent isn't set up ("Voice coming soon").
// available=false: voice is kept for live demos on this device; the mic opens a calm sheet instead.
//
//   POST /functions/v1/voice-session/unlock { code } -> { presenter_token, expires_at }
// Unlocks this device for presenting for 7 days: the staff login (the one used for /demo) needs no
// code; anyone else signed in types the presenter code (VOICE_PRESENTER_CODE, constant-time; 5 wrong
// codes per address per 15 minutes). The token is only ever on the device.
//   POST /functions/v1/voice-session/lock { presenter_token } -> revokes that unlock.
//
// Sign-up by voice: before she has a login, the app sends { onboarding_token } instead. The
// plus_session minted then is bound to the sign-up ("ob:<id>"), not to a user, so the agent can only
// run the sign-up steps (it can never set the PIN or hear the ID number or the phone code).
//
// The app starts the ElevenLabs session with the signed URL and passes plus_session as a dynamic
// variable; every tool call sends it back to agent-tools, which checks it. The ElevenLabs API key
// never leaves the server.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { bearer, json, preflight, health, withCors } from "../_shared/http.ts";
import { demoOff } from "../_shared/demo.ts";
import { hasSessionToken, mintSession, verifySession } from "../_shared/session.ts";
import { addressHash, dailyCap, mintPresenterToken, presenterCodeMatches, presenterUnlockId, voiceMode } from "../_shared/voice-mode.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Is this device unlocked for presenting? The unlock row must still be live (not revoked, not expired). */
async function liveUnlock(token: unknown, secret: string): Promise<string | null> {
  const id = await presenterUnlockId(token, secret);
  if (!id) return null;
  const { data } = await db.from("presenter_unlocks").select("id").eq("id", id).is("revoked_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
  return data ? id : null;
}

Deno.serve(withCors(async (req) => {
  const up = health(req, "voice-session");
  if (up) return up;
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // no body
  }
  let user: { id: string; name: string | null; language: string; market_id: string } | null = null;
  if (hasSessionToken(body.onboarding_token)) {
    // A sign-up in progress (no login yet).
    const check = await verifySession(body.onboarding_token, Deno.env.get("VOICE_SESSION_SECRET") ?? "");
    if (!check.ok || !check.userId.startsWith("ob:")) return json({ error: "invalid_onboarding" }, 401);
    const { data: s } = await db.from("onboarding_sessions").select("id, market_id, name, language, finished_at").eq("id", check.userId.slice(3)).maybeSingle();
    if (!s || s.finished_at) return json({ error: "invalid_onboarding" }, 401);
    user = { id: check.userId, name: s.name, language: s.language ?? "en", market_id: s.market_id };
  } else {
    const token = bearer(req);
    if (!token) return json({ error: "unauthorized" }, 401);
    const { data: auth, error: authErr } = await db.auth.getUser(token);
    if (authErr || !auth.user) return json({ error: "unauthorized" }, 401);
    // The staff login (/demo) has no Plus account: it may only unlock this device for presenting.
    if (auth.user.app_metadata?.role === "staff") {
      if (!new URL(req.url).pathname.endsWith("/unlock")) return json({ error: "no_plus_account" }, 403);
      user = { id: `staff:${auth.user.id}`, name: null, language: "en", market_id: "ng" };
    } else {
      const { data, error } = await db.from("users").select("id, name, language, market_id, demo_login").eq("auth_user_id", auth.user.id).maybeSingle();
      if (error) return json({ error: "internal" }, 500);
      if (!data) return json({ error: "no_plus_account" }, 403);
      const off = demoOff(data);
      if (off) return off;
      user = data;
    }
  }

  const path = new URL(req.url).pathname;
  const secret = Deno.env.get("VOICE_SESSION_SECRET") ?? "";
  const mode = voiceMode();

  if (path.endsWith("/unlock")) {
    if (!secret) return json({ error: "voice_not_configured" }, 503);
    let via: "staff" | "code" = "staff";
    if (!user.id.startsWith("staff:")) {
      via = "code";
      const ip = await addressHash(req, secret);
      const { data: allowed } = await db.rpc("presenter_code_allowed", { p_ip_hash: ip });
      if (allowed !== true) return json({ ok: false, error: "too_many_attempts", text: "Too many tries. Wait 15 minutes." }, 429);
      const ok = await presenterCodeMatches(body.code);
      await db.from("presenter_code_attempts").insert({ ip_hash: ip, ok });
      if (!ok) return json({ ok: false, error: "wrong_code", text: "That code isn't right." }, 403);
    }
    const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const { data: row, error } = await db.from("presenter_unlocks").insert({ via, expires_at: expires }).select("id").single();
    if (error || !row) return json({ error: "internal" }, 500);
    const t = await mintPresenterToken(row.id as string, secret);
    console.log(`voice-session: device unlocked for presenting (${via}), until ${new Date(t.expiresAt * 1000).toISOString()}`);
    return json({ ok: true, presenter_token: t.token, expires_at: new Date(t.expiresAt * 1000).toISOString(), via });
  }
  if (path.endsWith("/lock")) {
    const id = await presenterUnlockId(body.presenter_token, secret);
    if (id) await db.from("presenter_unlocks").update({ revoked_at: new Date().toISOString() }).eq("id", id).is("revoked_at", null);
    return json({ ok: true });
  }

  const apiKey = Deno.env.get("ELEVENLABS_API_KEY");
  // One ElevenLabs agent per market: Nigeria users get the Pidgin/Yoruba "Plus Nigeria" agent.
  const agentId = user.market_id === "ng" ? Deno.env.get("ELEVENLABS_AGENT_ID_NG") : Deno.env.get("ELEVENLABS_AGENT_ID");
  const configured = Boolean(apiKey && agentId && secret);
  const unlock = mode === "presenter" ? await liveUnlock(body.presenter_token, secret) : null;
  const available = configured && (mode === "on" || (mode === "presenter" && unlock !== null));
  const reason = !configured ? "not_configured" : mode === "off" ? "voice_off" : !available ? "presenter_only" : null;

  if (path.endsWith("/status")) {
    const { data: today } = await db.rpc("voice_today");
    const t = (today ?? {}) as { sessions?: number; unlocks?: number };
    return json({ configured, market: user.market_id, mode, available, reason, presenter: unlock !== null, today: t.sessions ?? null, cap: dailyCap(), unlocks: t.unlocks ?? null });
  }
  if (!configured) {
    console.error("voice-session: ELEVENLABS_API_KEY, the market's ELEVENLABS_AGENT_ID(_NG) or VOICE_SESSION_SECRET is not set");
    return json({ error: "voice_not_configured", configured: false }, 503);
  }
  if (!available) return json({ error: reason, mode, text: "Voice is switched on for live demos." }, 403);

  // The daily budget: counted before ElevenLabs is asked, so a refusal never costs anything.
  const cap = dailyCap();
  const { data: claim, error: claimErr } = await db.rpc("voice_session_claim", { p_subject: user.id, p_unlock: unlock, p_cap: cap });
  if (claimErr) return json({ error: "internal" }, 500);
  if (!(claim as { ok: boolean }).ok) {
    console.error(`voice-session: DAILY CAP HIT, ${(claim as { count: number }).count} of ${cap} voice sessions used today (Lagos). New sessions refused until midnight; raise VOICE_DAILY_SESSION_CAP to allow more.`);
    return json({ error: "voice_daily_cap", mode, text: "Voice is switched on for live demos." }, 429);
  }

  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId!)}`,
    { headers: { "xi-api-key": apiKey! }, signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) {
    console.error(`voice-session: ElevenLabs get-signed-url ${res.status}`);
    return json({ error: "voice_unavailable" }, 502);
  }
  const { signed_url } = await res.json() as { signed_url?: string };
  if (!signed_url) return json({ error: "voice_unavailable" }, 502);

  const session = await mintSession(user.id, secret);
  return json({
    signed_url,
    plus_session: session.token,
    expires_at: new Date(session.expiresAt * 1000).toISOString(),
    name: user.name,
    language: user.language,
    onboarding: user.id.startsWith("ob:"),
  });
}));
