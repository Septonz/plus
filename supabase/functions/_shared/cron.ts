// Who may run background jobs (chain-worker, sync-events):
// - Supabase Cron / the chain_outbox trigger: x-plus-cron-secret, checked inside the database
//   against the Vault secret plus_cron_secret (the function never reads the secret itself);
// - other Edge Functions and operators: x-plus-secret (AGENT_SHARED_SECRET).
// Both jobs only drain work that is already in the database; they take no input.
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasValidAgentSecret } from "./auth.ts";

export async function mayRunJob(req: Request, db: SupabaseClient): Promise<boolean> {
  if (hasValidAgentSecret(req)) return true;
  const cron = req.headers.get("x-plus-cron-secret");
  if (!cron) return false;
  const { data, error } = await db.rpc("check_cron_secret", { p_secret: cron });
  return !error && data === true;
}
