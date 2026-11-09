// Small HTTP helpers shared by the Edge Functions: CORS for the app, JSON responses, bearer
// tokens, and the "run chain-worker now" kick.

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS_HEADERS } });
}

export function preflight(req: Request): Response | null {
  return req.method === "OPTIONS" ? new Response("ok", { headers: CORS_HEADERS }) : null;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export async function readJson(req: Request): Promise<Record<string, unknown> | Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
}

/** Ask chain-worker to drain the outbox now (cron runs it every minute anyway). Never throws. */
export async function kickChainWorker(): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL");
  const secret = Deno.env.get("AGENT_SHARED_SECRET");
  if (!url || !secret) return;
  try {
    await fetch(`${url}/functions/v1/chain-worker`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-plus-secret": secret },
      body: "{}",
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // The worker keeps running after we stop waiting; cron is the fallback.
  }
}
