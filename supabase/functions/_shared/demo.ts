// Demo guardrails for the public showcase link (see the migration demo_guardrails).
//
//   DEMO_LOGINS_ENABLED (Supabase secret): only "true" lets the named demo people (rows with
//   demo_login) act. Turn the showcase off in one command:
//     npx supabase secrets set DEMO_LOGINS_ENABLED=false --project-ref qoqmnjzfjhpemwleipth
//   Money actions by a demo person are rate-limited (demo_rate_ok), whatever the switch.
//   Piece 12: guests (public test accounts, guest_slot set) get the same limit, with a guest's message.
import type { SupabaseClient } from "@supabase/supabase-js";
import { json } from "./http.ts";

/** The only logins that use the shared demo password (`pnpm demo:logins`). */
export const DEMO_EMAILS: readonly string[] = [
  "demo-funmi@example.com",
  "demo-kemi@example.com",
  "demo-selvi@example.com",
  "demo-mamabisi@example.com",
  "demo-meena@example.com",
];

export const DEMO_LIMITS = { per10min: 15, perDay: 120 } as const;

/** Tools that move money (or start moving it): counted for demo people. */
export const MONEY_TOOLS: ReadonlySet<string> = new Set([
  "prepare_pay", "prepare_advance", "prepare_cashout",
  "new_cashout_code", "confirm_action", "simulate_bank_transfer", "prepare_loan", "prepare_repay", "request_more_time",
  "record_cash_in", "redeem_code", "guest_cash_in", "guest_agent_paid",
]);

export function demoLoginsEnabled(): boolean {
  return (Deno.env.get("DEMO_LOGINS_ENABLED") ?? "").trim().toLowerCase() === "true";
}

/** A demo person when the showcase is switched off: refused before anything runs. */
export function demoOff(actor: { demo_login?: boolean | null } | null | undefined): Response | null {
  if (!actor?.demo_login || demoLoginsEnabled()) return null;
  return json({ error: "demo_off", text: "The demo logins are switched off." }, 403);
}

/** A money action by a demo person: counted, and refused past the limit. */
export async function demoRateLimited(
  db: SupabaseClient,
  actor: { id: string; demo_login?: boolean | null; guest_slot?: number | null } | null | undefined,
  tool: string,
): Promise<Response | null> {
  const guest = actor?.guest_slot !== null && actor?.guest_slot !== undefined;
  if (!actor || (!actor.demo_login && !guest)) return null;
  const { data, error } = await db.rpc("demo_rate_ok", {
    p_actor: actor.id,
    p_tool: tool,
    p_per_10min: DEMO_LIMITS.per10min,
    p_per_day: DEMO_LIMITS.perDay,
  });
  if (error) throw error;
  if (data === true) return null;
  return json({
    ok: false,
    error: "demo_rate_limited",
    text: guest
      ? "You've tried a lot of payments in a few minutes. Take a short break and try again in a few minutes. This keeps the test fair for everyone."
      : "This demo person has done a lot of payments just now. Try again in a few minutes.",
  }, 429);
}
