// text-command (piece 13, item 2): "Type to Plus". What she types goes through a deterministic
// parser (_shared/intent.ts: no LLM, no ElevenLabs) and then the same agent-tools actions the voice
// agent calls, with a server-minted plus_session (15 minutes, her user id only), so typed and spoken
// commands behave the same: money tools only PREPARE; she confirms on her screen (PIN where needed).
//
// verify_jwt = true (the gateway checks the JWT), then the first step of every route is her login.
//
//   POST /functions/v1/text-command { text }
//     -> { kind: "tool", tool, echo, text, result }         an agent-tools answer (balance, a prepared payment…)
//      | { kind: "navigate", screen, echo }                  open a screen (the app's own navigate)
//      | { kind: "ask", text, options? }                     a question back, with tappable answers
//      | { kind: "unknown", text, suggestions }              3 tappable suggestions
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { bearer, json, preflight, withCors } from "../_shared/http.ts";
import { demoOff } from "../_shared/demo.ts";
import { mintSession } from "../_shared/session.ts";
import { type Market, parseCommand, toYou } from "../_shared/intent.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const MAX_TEXT = 200;


Deno.serve(withCors(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  // First, on every route: her login.
  const token = bearer(req);
  if (!token) return json({ error: "unauthorized" }, 401);
  const { data: auth, error: authErr } = await db.auth.getUser(token);
  if (authErr || !auth.user) return json({ error: "unauthorized" }, 401);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const { data: user, error } = await db.from("users").select("id, market_id, demo_login").eq("auth_user_id", auth.user.id).is("archived_at", null).maybeSingle();
  if (error) return json({ error: "internal" }, 500);
  if (!user) return json({ error: "no_plus_account", text: "This login is not linked to a Plus account." }, 403);
  const off = demoOff(user);
  if (off) return off;

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // no body
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TEXT) : "";
  if (!text) return json({ error: "empty", text: "Type what you need, like “balance” or “pay Iya Tunde 2000”." }, 400);

  const market = (user.market_id === "in" ? "in" : "ng") as Market;
  const { data: payees } = await db.from("payees").select("name").eq("user_id", user.id);
  const parsed = parseCommand(text, { market, payees: ((payees ?? []) as { name: string }[]).map((p) => p.name) });

  if (parsed.kind === "unknown") {
    return json({ ...parsed, text: "I didn't catch that. Try one of these:" });
  }
  if (parsed.kind !== "tool") return json(parsed);

  // The same agent-tools call the voice agent makes, for her only.
  const secret = Deno.env.get("VOICE_SESSION_SECRET") ?? "";
  const shared = Deno.env.get("AGENT_SHARED_SECRET") ?? "";
  if (!secret || !shared) return json({ error: "not_configured" }, 503);
  const { token: plusSession } = await mintSession(user.id, secret);
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/agent-tools/${parsed.tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-plus-secret": shared, "x-plus-channel": "text" },
    body: JSON.stringify({ ...parsed.args, plus_session: plusSession }),
  });
  const result = await r.json().catch(() => ({})) as Record<string, unknown>;
  return json({ kind: "tool", tool: parsed.tool, echo: parsed.echo, text: typeof result.text === "string" ? toYou(result.text) : null, result }, r.ok ? 200 : r.status);
}));
