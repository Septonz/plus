// Small HTTP helpers shared by the Edge Functions: CORS for the app, JSON responses, bearer
// tokens, and the "run chain-worker now" kick.

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

/**
 * Browsers may call the functions only from these origins: the live app, local dev, and any
 * extra ones in the ALLOWED_ORIGINS secret (comma-separated, e.g. a Vercel preview). Server
 * callers (ElevenLabs webhooks, scripts, cron) send no Origin and are not affected.
 */
export const APP_ORIGINS: readonly string[] = [
  "https://plus-wallet.vercel.app",
  "http://localhost:5173",
  "http://localhost:5199",
  "http://localhost:4173",
  "http://127.0.0.1:5173",
  ...(Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((o) => o.trim()).filter(Boolean),
];
// Vercel previews of this project (plus-wallet-<hash>-<team>.vercel.app).
const PREVIEW = /^https:\/\/plus-wallet-[a-z0-9-]+\.vercel\.app$/;

export function allowedOrigin(origin: string | null): boolean {
  return Boolean(origin) && (APP_ORIGINS.includes(origin!) || PREVIEW.test(origin!));
}

/** Wraps a handler: answers with the caller's origin when it is allowed, and with none otherwise. */
export function withCors(handler: (req: Request) => Response | Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    const res = await handler(req);
    const origin = req.headers.get("origin");
    if (!origin) return res;
    const headers = new Headers(res.headers);
    headers.set("access-control-allow-origin", allowedOrigin(origin) ? origin : "null");
    headers.append("vary", "origin");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS_HEADERS } });
}

const BOOTED_AT = Date.now();
let healthHits = 0;

/**
 * GET .../<function>/health: no auth, no database, nothing secret. Used by `pnpm warm` and the
 * warm-up cron so no demo request hits a cold start. `cold` is true on the first call this
 * isolate has served.
 */
export function health(req: Request, fn: string): Response | null {
  if (req.method !== "GET" || !new URL(req.url).pathname.endsWith("/health")) return null;
  healthHits++;
  return json({ ok: true, fn, cold: healthHits === 1, up_ms: Date.now() - BOOTED_AT });
}

/** The Edge Functions that serve the demo, in the order `pnpm warm` pings them. */
export const DEMO_FUNCTIONS = ["agent-tools", "chain-worker", "agent-api", "voice-session", "helper-api", "payout-sim", "scheduler", "sync-events"] as const;

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
