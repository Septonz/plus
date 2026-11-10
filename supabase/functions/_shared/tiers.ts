// KYC tiers (market pack, kyc.tiers): what each tier may do. Every money tool asks these before it
// prepares anything; the limits are the partner's to set, the pack only models them.
//   tier 0  sign-up not finished: no money moves
//   tier 1  name, phone, selfie: low daily and balance limits, no advances
//   tier 2  + ID checked (Nigeria: NIN): higher limits, advances after eligibleAfterWeeks
import { formatMoney, formatSpokenMoney, getMarket, type MarketId, tierOf } from "./markets.ts";

export interface TierUser {
  market_id: MarketId;
  kyc_tier: number;
  member_since?: string | null;
}

export type TierRefusal = { text: string; ok: false; error: string; [k: string]: unknown };

const say = (minor: bigint, m: MarketId) => formatSpokenMoney(minor, m);

function refuse(text: string, error: string, extra: Record<string, unknown> = {}): TierRefusal {
  return { text, ok: false, error, ...extra };
}

/** Today's cap: the lower of the market's daily payment limit and her tier's. */
export function dailyCap(user: TierUser): bigint | null {
  const t = tierOf(user.market_id, user.kyc_tier);
  if (!t) return null;
  const m = getMarket(user.market_id);
  return BigInt(Math.min(m.payDailyLimit, t.dailyLimit)) * 100n;
}

/** May she send `amount` (minor units) out today, having sent `paidToday` already? */
export function spendAllowed(user: TierUser, amount: bigint, paidToday: bigint): TierRefusal | null {
  const cap = dailyCap(user);
  const m = user.market_id;
  if (cap === null) return refuse("Her account is not open yet. Finish signing up first.", "signup_not_finished");
  if (paidToday + amount > cap) {
    const left = cap > paidToday ? cap - paidToday : 0n;
    const up = user.kyc_tier < 2 && getMarket(m).kyc.idDocument
      ? ` Checking her ${getMarket(m).kyc.idDocument!.name} raises the limit.`
      : "";
    return refuse(`That is over today's limit. She can send ${say(left, m)} more today.${up}`, "daily_limit", {
      left_today_text: formatMoney(left, m),
      tier: user.kyc_tier,
    });
  }
  return null;
}

/** Most her wallet may hold (minor units); null when sign-up is not finished. */
export function balanceCap(user: TierUser): bigint | null {
  const t = tierOf(user.market_id, user.kyc_tier);
  return t ? BigInt(t.balanceLimit) * 100n : null;
}

/** May `amount` come into a wallet that holds `balance` now (plus money already on its way in)? */
export function receiveAllowed(user: TierUser, balance: bigint, amount: bigint, who = "her"): TierRefusal | null {
  const cap = balanceCap(user);
  const m = user.market_id;
  if (cap === null) return refuse(`${who === "her" ? "Her" : "That"} account is not open yet.`, "signup_not_finished");
  if (balance + amount > cap) {
    const room = cap > balance ? cap - balance : 0n;
    return refuse(
      `That would take ${who} wallet over its limit of ${say(cap, m)}. ` +
        (room > 0n ? `Up to ${say(room, m)} can come in now.` : "Nothing more can come in until some is spent."),
      "balance_limit",
      { room_text: formatMoney(room, m), limit_text: formatMoney(cap, m) },
    );
  }
  return null;
}

/** Advances: tier 2 (or above) and a member for eligibleAfterWeeks. */
export function advanceAllowed(user: TierUser, now: Date = new Date()): TierRefusal | null {
  const m = getMarket(user.market_id);
  const t = tierOf(user.market_id, user.kyc_tier);
  if (!t || !t.advances) {
    const doc = m.kyc.idDocument;
    return refuse(
      doc ? `Advances open once her ${doc.name} is checked. She can add it in Settings, on her screen.` : "Advances open once her bank has checked her ID.",
      "tier_too_low",
      { tier: user.kyc_tier },
    );
  }
  const since = user.member_since ? new Date(user.member_since).getTime() : now.getTime();
  const weeks = Math.floor((now.getTime() - since) / (7 * 86_400_000));
  if (weeks < m.advance.eligibleAfterWeeks) {
    const left = m.advance.eligibleAfterWeeks - weeks;
    return refuse(`Advances open after ${m.advance.eligibleAfterWeeks} weeks with Plus: ${left} more week${left === 1 ? "" : "s"}.`, "too_new", {
      weeks_left: left,
    });
  }
  return null;
}

/** A plain description of her tier, for screens and the voice agent. */
export function tierSummary(user: TierUser) {
  const t = tierOf(user.market_id, user.kyc_tier);
  const m = user.market_id;
  if (!t) return { tier: 0, daily_text: null, balance_text: null, advances: false };
  return {
    tier: user.kyc_tier >= 2 ? 2 : 1,
    daily_text: formatMoney(dailyCap(user)!, m),
    balance_text: formatMoney(BigInt(t.balanceLimit) * 100n, m),
    advances: t.advances,
  };
}
