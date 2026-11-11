// Who may run background jobs (chain-worker, scheduler, sync-events):
// - Supabase Cron / the chain_outbox trigger: x-plus-cron-secret, checked inside the database
//   against the Vault secret plus_cron_secret (the function never reads the secret itself);
// - other Edge Functions and operators: x-plus-secret (AGENT_SHARED_SECRET).
// Both jobs only drain work that is already in the database; they take no input.
//
// scheduler and sync-events run with verify_jwt = false (pg_cron sends no JWT), so this check is
// the only door: jobGate is the first statement of their handlers, before every route, /health
// included (job-gate.test.ts proves it, route by route).
import { hasValidAgentSecret } from "./auth.ts";
import { health, json } from "./http.ts";

/** The one database call the check needs (a Supabase client fits). */
export type JobDb = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

export async function mayRunJob(req: Request, db: JobDb): Promise<boolean> {
  if (hasValidAgentSecret(req)) return true;
  const cron = req.headers.get("x-plus-cron-secret");
  if (!cron) return false;
  const { data, error } = await db.rpc("check_cron_secret", { p_secret: cron });
  return !error && data === true;
}

/**
 * The first step of every route in a job function: 401 without a valid cron or agent secret.
 * After that, GET /health answers here; anything else returns null (carry on).
 */
export async function jobGate(req: Request, db: JobDb, fn: string): Promise<Response | null> {
  if (!(await mayRunJob(req, db))) return json({ error: "unauthorized" }, 401);
  return health(req, fn);
}

/**
 * /health for a function that otherwise needs a login (payout-sim): only with a cron or agent secret,
 * so `pnpm warm` and scheduler/warm can wake it without the gateway JWT (approved 2026-11-10).
 * Any other route returns null: the function's own login check comes next.
 */
export async function privateHealth(req: Request, db: JobDb, fn: string): Promise<Response | null> {
  if (req.method !== "GET" || !new URL(req.url).pathname.endsWith("/health")) return null;
  if (!(await mayRunJob(req, db))) return json({ error: "unauthorized" }, 401);
  return health(req, fn);
}
