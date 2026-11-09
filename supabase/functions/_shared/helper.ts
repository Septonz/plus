// Helper (group leader / correspondent) rules shared by helper-api and its tests.
// The database enforces the daily limit atomically (helper_record_cash_in); this is the same
// rule in TypeScript so the helper page can say how much is left before asking.
import { formatMoney, type MarketId } from "./markets.ts";

export type Allowance = { ok: true; leftAfter: bigint } | { ok: false; left: bigint };

/** May a helper who has recorded `used` today (minor units) record `amount` more? */
export function cashInAllowance(used: bigint, limit: bigint, amount: bigint): Allowance {
  const left = limit > used ? limit - used : 0n;
  if (amount <= 0n || amount > left) return { ok: false, left };
  return { ok: true, leftAfter: left - amount };
}

/** What the user sees and hears: "Meena says you gave her ₹500 in cash. Is that right?" */
export function cashInReadback(helperName: string, amount: bigint, market: MarketId): string {
  return `${helperName} says you gave her ${formatMoney(amount, market)} in cash. Is that right?`;
}
