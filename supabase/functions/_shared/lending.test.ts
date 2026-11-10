import { assert, assertEquals } from "jsr:@std/assert@1";
import { affordable, type CreditAsset, type CreditInput, type CreditLoan, creditPicture, lendingValue, weekNumber } from "./lending.ts";

const N = (naira: number) => BigInt(naira) * 100n;
const NOW = new Date("2026-11-10T12:00:00Z");
const weeksAgo = (w: number, days = 0) => new Date(NOW.getTime() - (w * 7 + days) * 86_400_000).toISOString();

const STOCK: CreditAsset = {
  id: "a1", type: "stock", description: "Stall stock (tomatoes)", estimated_value: N(90_000), level: "independently_verified", status: "active",
};

function weeks(from: number, to: number, moneyIn: number, tx = 6, saved = 1_000) {
  const out = [];
  for (let w = from; w <= to; w++) out.push({ week: w, money_in: N(moneyIn), qualifying_tx: tx, saved: N(saved) });
  return out;
}

function loan(over: Partial<CreditLoan> = {}): CreditLoan {
  return {
    id: "l1", step: 0, principal: N(30_000), cost: N(1_800), total: N(31_800), repaid: 0n, in_flight: 0n, period_paid: 0n,
    outstanding: N(31_800), minimum: N(2_500), repay_bps: 1000, every_days: 14, collateral_pct: 150, status: "active",
    next_due_at: weeksAgo(-2), grace_until: null, missed: 0, extended_once: false, restructured_once: false,
    borrowing_paused: false, closed_by_reset: false, disbursed: "completed", created_at: weeksAgo(0), ...over,
  };
}

// Funmi: 20 weeks with Plus, about ₦12,500 a week coming in, ajo every week, stall stock verified.
const funmi = (over: Partial<CreditInput> = {}): CreditInput => ({
  member_since: weeksAgo(20), kyc_tier: 2, frozen_until: null, weeks: weeks(1, 21, 12_500), assets: [STOCK], loans: [], now: NOW, ...over,
});

// Kemi: in her fourth week, money in 3 of them, no asset yet.
const kemi = (over: Partial<CreditInput> = {}): CreditInput => ({
  member_since: weeksAgo(3, 2), kyc_tier: 2, frozen_until: null,
  weeks: [...weeks(1, 1, 8_000, 3, 0), ...weeks(3, 4, 9_000, 3, 500)], assets: [], loans: [], now: NOW, ...over,
});

Deno.test("week number: week 1 starts the day she joins", () => {
  assertEquals(weekNumber(NOW.toISOString(), NOW), 1);
  assertEquals(weekNumber(weeksAgo(3, 2), NOW), 4);
  assertEquals(weekNumber(weeksAgo(6), NOW), 7);
});

Deno.test("Kemi, week 4 of 6: progress and an estimate, never an offer", () => {
  const p = creditPicture(kemi());
  assertEquals(p.week, 4);
  assertEquals(p.weeks_left, 2);
  assertEquals(p.unlocked, false);
  assertEquals(p.offer, null);
  const c = Object.fromEntries(p.checklist.map((x) => [x.key, x]));
  assertEquals(c.identity.done, true);
  assertEquals(c.active_weeks.detail, "3 of 4");
  assertEquals(c.transactions.detail, "9 of 12");
  assertEquals(c.asset.done, false);
  assertEquals(c.weeks.detail, "2 more weeks needed");
  assert(p.estimate.low > 0n && p.estimate.high >= p.estimate.low);
  const words = JSON.stringify(p.checklist).toLowerCase();
  assert(!words.includes("rejected") && !words.includes("not eligible"));
});

Deno.test("a brand-new sign-up is in week 1 of 6", () => {
  const p = creditPicture(kemi({ member_since: NOW.toISOString(), weeks: [] }));
  assertEquals(p.week, 1);
  assertEquals(p.weeks_left, 5);
  assertEquals(p.unlocked, false);
});

Deno.test("Funmi: ₦30,000 offer at 6%: ₦1,800 cost, ₦31,800 total; the lowest of ladder, affordability and collateral", () => {
  const p = creditPicture(funmi());
  assert(p.unlocked);
  assertEquals(p.offer?.amount, N(30_000));
  assertEquals(p.offer?.cost, N(1_800));
  assertEquals(p.offer?.total, N(31_800));
  assertEquals(p.offer?.collateral_pct, 150);
  assertEquals(p.affordability.estimated_value, N(90_000));
  assertEquals(p.affordability.lending_value, N(54_000));
  assertEquals(p.affordability.affordable, N(30_000));
  assertEquals(p.why.map((w) => w.weight), [40, 35, 25]);
  assertEquals(p.why[2].detail, "Ajo paid in 8 of 8 weeks"); // the last 8 weeks, not all 21
  assertEquals(p.ladder.map((s) => s.max), [N(30_000), N(50_000), N(80_000), N(80_000)]);
});

Deno.test("affordability: 10% of typical weekly money-in over 12 weeks plus six minimums, floored to ₦5,000", () => {
  assertEquals(affordable(weeks(1, 8, 12_500), 8), N(30_000)); // 15,000 + 15,000
  assertEquals(affordable(weeks(1, 8, 5_000), 8), N(20_000)); // 6,000 + 15,000 = 21,000 -> 20,000
  assertEquals(affordable([], 8), 0n);
});

Deno.test("a merely registered asset has no lending value; lost or stolen ones don't count", () => {
  assertEquals(lendingValue([{ ...STOCK, level: "registered" }]), 0n);
  assertEquals(lendingValue([{ ...STOCK, status: "stolen" }]), 0n);
  assertEquals(lendingValue([{ ...STOCK, level: "evidence_verified" }]), N(27_000));
});

Deno.test("collateral can be the limit: evidence verified stock (₦27,000) at 150% -> ₦18,000", () => {
  const p = creditPicture(funmi({ assets: [{ ...STOCK, level: "evidence_verified" }] }));
  assertEquals(p.offer?.amount, N(18_000));
  assertEquals(p.affordability.limited_by, "collateral");
});

Deno.test("the ladder: a repaid loan moves her up; a demo reset's settlement does not", () => {
  const up = creditPicture(funmi({ weeks: weeks(1, 21, 40_000), loans: [loan({ status: "repaid" })] }));
  assertEquals(up.step, 1);
  assertEquals(up.offer?.amount, N(43_000)); // ₦54,000 lending value / 125%, floored to ₦1,000
  assertEquals(up.offer?.cost_bps, 500);
  const reset = creditPicture(funmi({ loans: [loan({ status: "repaid", closed_by_reset: true })] }));
  assertEquals(reset.step, 0);
});

Deno.test("one loan at a time; a late payment or a freeze blocks new borrowing", () => {
  assertEquals(creditPicture(funmi({ loans: [loan()] })).offer, null);
  assertEquals(creditPicture(funmi({ loans: [loan()] })).blocked, "loan_open");
  assertEquals(creditPicture(funmi({ loans: [loan({ borrowing_paused: true })] })).blocked, "paused");
  const frozen = creditPicture(funmi({ frozen_until: "infinity" })); // as Postgres returns it
  assertEquals(frozen.blocked, "frozen");
  assertEquals(frozen.offer, null);
  const late = creditPicture(funmi({ loans: [loan({ status: "late" })] }));
  assertEquals(late.checklist.find((c) => c.key === "standing")?.done, false);
});
