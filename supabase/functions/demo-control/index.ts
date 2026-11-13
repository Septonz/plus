// demo-control (piece 13, item 10): the staff /demo page's "Reset for recording".
//
// verify_jwt = true (the gateway checks the JWT), and the first step of every route is the staff
// check: app_metadata.role = staff (the /demo login from pnpm staff:create), or the agent secret
// (x-plus-secret, server-side only) for pnpm recording:reset. Nobody else gets in.
//
//   POST /functions/v1/demo-control/recording-reset           -> { gen }
//       The database half of the reset (_shared/presenter-reset.ts), at once.
//   POST /functions/v1/demo-control/recording-step { gen }    -> { done, step, note?, warm? }
//       One Stellar step (through the chain outbox); the page calls it every few seconds. When the
//       state is back, every demo function is warmed and the answer is done: "Ready to record".
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { bearer, DEMO_FUNCTIONS, json, kickChainWorker, preflight, withCors } from "../_shared/http.ts";
import { hasValidAgentSecret } from "../_shared/auth.ts";
import { recordingConverge, recordingDbReset } from "../_shared/presenter-reset.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Every demo function's /health and agent-tools' deeper warm-up, with the milliseconds each took. */
async function warm() {
  const base = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
  const headers = { "x-plus-secret": Deno.env.get("AGENT_SHARED_SECRET") ?? "" };
  const hit = async (path: string) => {
    const t = performance.now();
    const status = await fetch(`${base}/${path}`, { headers, signal: AbortSignal.timeout(10_000) }).then((r) => r.status, () => 0);
    return { path, status, ms: Math.round(performance.now() - t) };
  };
  return await Promise.all([...DEMO_FUNCTIONS.map((f) => hit(`${f}/health`)), hit("agent-tools/warm")]);
}

Deno.serve(withCors(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  // First, on every route: the staff login (or, for pnpm recording:reset, the agent secret).
  const token = bearer(req);
  if (!hasValidAgentSecret(req)) {
    if (!token) return json({ error: "unauthorized" }, 401);
    const { data: auth, error } = await db.auth.getUser(token);
    if (error || !auth.user) return json({ error: "unauthorized" }, 401);
    if (auth.user.app_metadata?.role !== "staff") return json({ error: "staff_only" }, 403);
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const path = new URL(req.url).pathname;
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // no body
  }
  try {
    if (path.endsWith("/recording-reset")) {
      const gen = await recordingDbReset(db);
      await kickChainWorker();
      return json({ ok: true, gen });
    }
    if (path.endsWith("/recording-step")) {
      const gen = Number(body.gen);
      if (!Number.isInteger(gen) || gen <= 0) return json({ error: "invalid_gen" }, 400);
      const s = await recordingConverge(db, gen, { contractId: Deno.env.get("PLUS_CONTRACT_ID") ?? "" });
      if (!s.done) {
        await kickChainWorker();
        return json(s);
      }
      return json({ ...s, warm: await warm() });
    }
    return json({ error: "not_found" }, 404);
  } catch (e) {
    console.error("demo-control", e instanceof Error ? e.message : e);
    return json({ error: "internal", note: e instanceof Error ? e.message.slice(0, 200) : "" }, 500);
  }
}));
