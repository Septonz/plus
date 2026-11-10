// voice-session: starts a voice conversation for the signed-in app user.
//
//   POST /functions/v1/voice-session      Authorization: Bearer <Supabase access token>
//   -> { signed_url, plus_session, expires_at }
//
// 1. Verifies the Supabase login and finds her Plus account (users.auth_user_id).
// 2. Gets a signed conversation URL for her market's private ElevenLabs agent (valid 15 minutes).
// 3. Mints plus_session: an HMAC token bound to her user id, expiring in 15 minutes.
//
//   POST /functions/v1/voice-session/status  -> { configured }  (no ElevenLabs call)
// The app asks this first and shows "Voice coming soon" when her market's agent isn't set up
// (for example ELEVENLABS_AGENT_ID_NG not set yet); once the secret exists it works, no code change.
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

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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
    const { data, error } = await db.from("users").select("id, name, language, market_id, demo_login").eq("auth_user_id", auth.user.id).maybeSingle();
    if (error) return json({ error: "internal" }, 500);
    if (!data) return json({ error: "no_plus_account" }, 403);
    const off = demoOff(data);
    if (off) return off;
    user = data;
  }

  const apiKey = Deno.env.get("ELEVENLABS_API_KEY");
  // One ElevenLabs agent per market: Nigeria users get the Pidgin/Yoruba "Plus Nigeria" agent.
  const agentId = user.market_id === "ng" ? Deno.env.get("ELEVENLABS_AGENT_ID_NG") : Deno.env.get("ELEVENLABS_AGENT_ID");
  const secret = Deno.env.get("VOICE_SESSION_SECRET");
  const configured = Boolean(apiKey && agentId && secret);
  if (new URL(req.url).pathname.endsWith("/status")) return json({ configured, market: user.market_id });
  if (!apiKey || !agentId || !secret) {
    console.error("voice-session: ELEVENLABS_API_KEY, the market's ELEVENLABS_AGENT_ID(_NG) or VOICE_SESSION_SECRET is not set");
    return json({ error: "voice_not_configured", configured: false }, 503);
  }

  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
    { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(8000) },
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
