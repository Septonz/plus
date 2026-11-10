// The lending model (piece 4), pure so it is unit-tested. Rules and numbers come from the market
// pack (markets.ts `lending`; illustrative, the partner lender sets the real ones). Amounts are kobo.
//
// Before she unlocks borrowing she sees her progress ("Building your Plus history, week 4 of 6")
// and an estimate that is not an offer. Never the words "rejected" or "not eligible".
// Once unlocked, the offer is the lowest of: this step's ladder amount, what she can afford, and her
// verified assets' lending value divided by the collateral this step needs.
import { type AssetLevel, getMarket, type Lending } from "./markets.ts";

export interface CreditWeek {
  week: number;
  money_in: bigint;
  qualifying_tx: number;
  saved: bigint;
}

export interface CreditAsset {
  id: string;
  type: string;
  description: string;
  estimated_value: bigint;
  level: AssetLevel;
  status: string;
}

export interface CreditLoan {
  id: string;
  step: number;
  principal: bigint;
  cost: bigint;
  total: bigint;
  repaid: bigint;
  in_flight: bigint;
  period_paid: bigint;
  outstanding: bigint;
  minimum: bigint;
  repay_bps: number;
  every_days: number;
  collateral_pct: number;
  status: "active" | "late" | "restructured" | "repaid" | "default";
  next_due_at: string;
  grace_until: string | null;
  missed: number;
  extended_once: boolean;
  restructured_once: boolean;
  borrowing_paused: boolean;
  closed_by_reset: boolean;
  disbursed: string;
  created_at: string;
}

export interface CreditInput {
  member_since: string;
  kyc_tier: number;
  frozen_until: string | null;
  weeks: CreditWeek[];
  assets: CreditAsset[];
  loans: CreditLoan[];
  now: Date;
}

export type CheckItem = { key: string; label: string; done: boolean; detail: string };

export const OPEN_STATUSES = new Set(["active", "late", "restructured"]);
const N = 100n; // kobo per naira

export function lendingRules(): Lending {
  const l = getMarket("ng").lending;
  if (!l) throw new Error("no lending in this market");
  return l;
}

/** Her week with Plus: week 1 starts the day she joined. */
export function weekNumber(memberSince: string, now: Date): number {
  return Math.max(1, Math.floor((now.getTime() - new Date(memberSince).getTime()) / (7 * 86_400_000)) + 1);
}

const floorTo = (v: bigint, step: bigint) => (v <= 0n ? 0n : (v / step) * step);

/** What she can repay over the affordability window: repay_bps of her typical weekly money-in, plus the minimums. */
export function affordable(weeks: CreditWeek[], current: number, L = lendingRules()): bigint {
  const recent = weeks.filter((w) => w.week <= current && w.week > current - 8 && w.money_in > 0n);
  if (recent.length === 0) return 0n;
  const avg = recent.reduce((s, w) => s + w.money_in, 0n) / BigInt(recent.length);
  const share = (avg * BigInt(L.affordability.weeks) * BigInt(L.repay.fromMoneyInBps)) / 10000n;
  const minimums = BigInt(L.repay.minimum) * N * BigInt(Math.floor((L.affordability.weeks * 7) / L.repay.everyDays));
  return floorTo(share + minimums, BigInt(L.affordability.roundTo) * N);
}

/** Lending value of her verified, active assets (stock valued at ₦90,000 and independently verified: ₦54,000). */
export function lendingValue(assets: CreditAsset[], L = lendingRules()): bigint {
  return assets.filter((a) => a.status === "active")
    .reduce((s, a) => s + (a.estimated_value * BigInt(L.lendingValueBps[a.level] ?? 0)) / 10000n, 0n);
}

export function costOf(amount: bigint, costBps: number): bigint {
  return (amount * BigInt(costBps)) / 10000n;
}

export function creditPicture(input: CreditInput, L = lendingRules()) {
  const now = input.now;
  const week = weekNumber(input.member_since, now);
  const sofar = input.weeks.filter((w) => w.week <= week);
  const activeWeeks = sofar.filter((w) => w.money_in > 0n).length;
  const qualifying = sofar.reduce((s, w) => s + w.qualifying_tx, 0);
  const savedWeeks = sofar.filter((w) => w.saved > 0n).length;
  const identity = input.kyc_tier >= 2;
  const open = input.loans.find((l) => OPEN_STATUSES.has(l.status)) ?? null;
  // Postgres returns a freeze "until repaid" as the string "infinity".
  const frozen = input.frozen_until !== null && (input.frozen_until === "infinity" || new Date(input.frozen_until) > now);
  const goodStanding = !frozen && !input.loans.some((l) => l.status === "late" || l.status === "default");
  const verified = input.assets.filter((a) => a.status === "active" && (L.lendingValueBps[a.level] ?? 0) > 0);
  const weeksLeft = Math.max(0, L.unlock.weeks - week);

  const checklist: CheckItem[] = [
    { key: "identity", label: "Identity verified", done: identity, detail: identity ? "NIN checked" : "Add your NIN in Profile" },
    {
      key: "transactions", label: "Qualifying transactions", done: qualifying >= L.unlock.minQualifyingTx,
      detail: `${Math.min(qualifying, L.unlock.minQualifyingTx)} of ${L.unlock.minQualifyingTx}`,
    },
    {
      key: "active_weeks", label: "Active weeks (money in)", done: activeWeeks >= L.unlock.activeWeeks,
      detail: `${Math.min(activeWeeks, L.unlock.activeWeeks)} of ${L.unlock.activeWeeks}`,
    },
    { key: "asset", label: "One verified asset", done: verified.length > 0, detail: verified.length > 0 ? verified[0].description : "Register one, then verify it" },
    {
      key: "weeks", label: `${L.unlock.weeks} weeks with Plus`, done: weeksLeft === 0,
      detail: weeksLeft === 0 ? "Done" : `${weeksLeft} more week${weeksLeft === 1 ? "" : "s"} needed`,
    },
    { key: "standing", label: "Good standing", done: goodStanding, detail: goodStanding ? "All payments on track" : "A payment is behind" },
  ];
  const unlocked = checklist.every((c) => c.done);

  // The ladder: each loan she repaid herself moves her up (a demo reset's settlement doesn't count).
  const repaidLoans = input.loans.filter((l) => l.status === "repaid" && !l.closed_by_reset).length;
  const stepIndex = Math.min(repaidLoans, L.ladder.length - 1);
  const step = L.ladder[stepIndex];

  const afford = affordable(input.weeks, week, L);
  const value = lendingValue(input.assets, L);
  const byCollateral = (value * 100n) / BigInt(step.collateralPct);
  const ladderMax = BigInt(step.max) * N;
  const amount = floorTo([ladderMax, afford, byCollateral].reduce((a, b) => (b < a ? b : a)), 1000n * N);
  const limitedBy = amount === floorTo(afford, 1000n * N) && afford <= ladderMax && afford <= byCollateral ? "affordability"
    : amount === floorTo(byCollateral, 1000n * N) && byCollateral <= ladderMax ? "collateral" : "ladder";

  // Why she got it: each part 0..1, weighted.
  const activity = Math.min(1, (Math.min(activeWeeks, 8) / 8 + Math.min(1, qualifying / (L.unlock.minQualifyingTx * 2))) / 2);
  const bestBps = verified.reduce((m, a) => Math.max(m, L.lendingValueBps[a.level] ?? 0), 0);
  const maxBps = Math.max(...Object.values(L.lendingValueBps));
  const assetsPart = maxBps > 0 ? bestBps / maxBps : 0;
  const considered = Math.max(1, Math.min(8, week));
  const savings = Math.min(1, savedWeeks / considered);
  const why = [
    { key: "activity", label: "Activity", weight: L.weights.activity, points: Math.round(activity * L.weights.activity), detail: `${activeWeeks} active weeks, ${qualifying} qualifying transactions` },
    { key: "assets", label: "Verified assets", weight: L.weights.assets, points: Math.round(assetsPart * L.weights.assets), detail: verified.length ? `${verified[0].description}, ${levelWords(verified[0].level)}` : "None verified yet" },
    { key: "savings", label: "Savings consistency", weight: L.weights.savings, points: Math.round(savings * L.weights.savings), detail: `Ajo paid in ${savedWeeks} of ${considered} weeks` },
  ];

  // Before unlock: an estimate, not an offer, from what she does now.
  const estHigh = floorTo([ladderMax, afford > 0n ? afford : ladderMax / 3n].reduce((a, b) => (b < a ? b : a)), 5000n * N);
  const estimate = { low: floorTo(estHigh / 3n, 5000n * N) || 5000n * N, high: estHigh || 10000n * N };

  const blocked = frozen ? "frozen" : open?.borrowing_paused ? "paused" : open ? "loan_open" : null;
  return {
    week,
    weeks_needed: L.unlock.weeks,
    weeks_left: weeksLeft,
    active_weeks: activeWeeks,
    qualifying,
    checklist,
    unlocked,
    estimate,
    open,
    blocked,
    step: stepIndex,
    offer: unlocked && !blocked && amount > 0n
      ? { amount, cost: costOf(amount, step.costBps), total: amount + costOf(amount, step.costBps), cost_bps: step.costBps, collateral_pct: step.collateralPct, approval: step.approval }
      : null,
    affordability: { estimated_value: verified.reduce((s, a) => s + (a.status === "active" ? a.estimated_value : 0n), 0n), lending_value: value, affordable: afford, by_collateral: byCollateral, ladder_max: ladderMax, limited_by: limitedBy },
    collateral_asset: verified[0] ?? null,
    why,
    score: why.reduce((s, w) => s + w.points, 0),
    ladder: L.ladder.map((s, i) => ({ step: i, max: BigInt(s.max) * N, cost_bps: s.costBps, collateral_pct: s.collateralPct, approval: s.approval, current: i === stepIndex })),
  };
}

export function levelWords(level: AssetLevel | string): string {
  return level === "independently_verified" ? "independently verified"
    : level === "community_verified" ? "community verified"
    : level === "evidence_verified" ? "evidence verified"
    : "registered";
}

/** Collateral as she reads it on the ladder: 150%, 125%, 100%, then partial. */
export function collateralWords(pct: number): string {
  return pct < 100 ? "partial" : `${pct}%`;
}
