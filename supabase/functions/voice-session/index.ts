// voice-session: starts a voice conversation for the signed-in app user.
//
//   POST /functions/v1/voice-session      Authorization: Bearer <Supabase access token>
//   -> { signed_url, plus_session, expires_at }
//
// 1. Verifies the Supabase login and finds her Plus account (users.auth_user_id).
// 2. Gets a signed conversation URL for the private ElevenLabs agent (valid 15 minutes).
// 3. Mints plus_session: an HMAC token bound to her user id, expiring in 15 minutes.
// The app starts the ElevenLabs session with the signed URL and passes plus_session as a dynamic
// variable; every tool call sends it back to agent-tools, which checks it. The ElevenLabs API key
// never leaves the server.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { bearer, json, preflight } from "../_shared/http.ts";
import { mintSession } from "../_shared/session.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const token = bearer(req);
  if (!token) return json({ error: "unauthorized" }, 401);
  const { data: auth, error: authErr } = await db.auth.getUser(token);
  if (authErr || !auth.user) return json({ error: "unauthorized" }, 401);
  const { data: user, error } = await db.from("users").select("id, name, language").eq("auth_user_id", auth.user.id).maybeSingle();
  if (error) return json({ error: "internal" }, 500);
  if (!user) return json({ error: "no_plus_account" }, 403);

  const apiKey = Deno.env.get("ELEVENLABS_API_KEY");
  const agentId = Deno.env.get("ELEVENLABS_AGENT_ID");
  const secret = Deno.env.get("VOICE_SESSION_SECRET");
  if (!apiKey || !agentId || !secret) {
    console.error("voice-session: ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID or VOICE_SESSION_SECRET is not set");
    return json({ error: "voice_not_configured" }, 503);
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
  });
});
