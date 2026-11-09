// Cash agents (Nigeria: Mama Bisi). Rules shared by agent-api and its tests. The database enforces
// the same rules atomically (agent_record_cash_in, cash_out_redeem); these give the agent an early,
// friendly answer.
import { formatMoney } from "./markets.ts";

/** "0803 123 4567", "+234 803 123 4567", "2348031234567" -> "+2348031234567"; null if not a Nigerian number. */
export function normalizeNgPhone(raw: string): string | null {
  const d = raw.replace(/[\s()-]/g, "");
  if (/^\+234\d{10}$/.test(d)) return d;
  if (/^234\d{10}$/.test(d)) return `+${d}`;
  if (/^0\d{10}$/.test(d)) return `+234${d.slice(1)}`;
  return null;
}

export type CashInCheck =
  | { ok: true; leftToday: bigint; floatAfter: bigint }
  | { ok: false; error: "invalid_amount" | "daily_limit_exceeded" | "float_too_low"; text: string };

/**
 * May an agent record `amount` (kobo) of cash now?
 *   used:      cash-ins recorded today (awaiting or confirmed)
 *   limit:     her daily limit
 *   float:     NGNT she holds on Stellar (Horizon)
 *   committed: cash-ins awaiting a Yes, or confirmed but not yet sent (they will leave her float)
 */
export function agentCashInCheck(x: { used: bigint; limit: bigint; float: bigint; committed: bigint; amount: bigint }): CashInCheck {
  if (x.amount <= 0n) return { ok: false, error: "invalid_amount", text: "Enter an amount." };
  const left = x.limit > x.used ? x.limit - x.used : 0n;
  if (x.amount > left) {
    return { ok: false, error: "daily_limit_exceeded", text: `That is over your limit for today. You can record ${formatMoney(left, "ng")} more today.` };
  }
  const free = x.float - x.committed;
  if (x.amount > free) {
    return { ok: false, error: "float_too_low", text: `Your float is too low: ${formatMoney(free > 0n ? free : 0n, "ng")} free. Top up your float first.` };
  }
  return { ok: true, leftToday: left - x.amount, floatAfter: free - x.amount };
}

/** "Mama Bisi says you gave her ₦500. Is that right?" */
export function agentCashInReadback(agentName: string, amount: bigint): string {
  return `${agentName} says you gave her ${formatMoney(amount, "ng")}. Is that right?`;
}

export type CashOutState = { status: string; expires_at: string; attempts: number };
export type RedeemCheck = { ok: true } | { ok: false; error: "not_redeemable" | "code_expired" | "too_many_attempts" };

/** Can an agent still redeem this cash-out? (Before 7 days, not used, fewer than maxAttempts wrong codes.) */
export function cashOutRedeemable(c: CashOutState, now: Date, maxAttempts: number): RedeemCheck {
  if (c.status !== "issued") return { ok: false, error: "not_redeemable" };
  if (new Date(c.expires_at).getTime() <= now.getTime()) return { ok: false, error: "code_expired" };
  if (c.attempts >= maxAttempts) return { ok: false, error: "too_many_attempts" };
  return { ok: true };
}

/** Constant-time comparison of two hex digests. */
export function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
