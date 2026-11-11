// Market packs for Plus: one shared core, one pack per country.
// Source of truth. Edit this file, then run `pnpm markets:sync`.
// Must stay dependency-free and runtime-agnostic (it is copied into Supabase Edge Functions).

export type MarketId = "in" | "ng";

export type CurrencyCode = "INR" | "NGN";

export interface Market {
  id: MarketId;
  country: string;
  currency: { code: CurrencyCode; symbol: string; onChain: boolean };
  languages: string[];
  custody: "partner_bank" | "stellar_account";
  usdBalance: boolean;
  domesticRail: "upi_sim" | "stellar";
  /** How cash becomes money in Plus. helper_record: a helper records cash handed over (India, the bank holds the money); agent_float: an agent swaps cash for on-chain naira from their float. */
  cashIn: ("helper_record" | "agent_float" | "bank_transfer")[];
  /** How money becomes cash. agent_guidance: Plus guides the user to a bank correspondent; claimable_code: a Stellar claimable balance an agent redeems. */
  cashOut: ("agent_guidance" | "claimable_code")[];
  /** Most a single helper may handle per day, in major units (rupees or naira), like advance and pinThreshold. */
  helperFloatLimit: number;
  incomingSources: string[];
  inboundCorridors: string[];
  autoSave: { enabled: boolean; defaultBps: number };
  groupSavings: { mode: "record" | "pooled"; localName: string };
  /** repayFromCashInBps: share of each cash-in that repays an open advance (Nigeria: on-chain, automatic). */
  advance: { min: number; max: number; feeBps: number; eligibleAfterWeeks: number; repayFromCashInBps: number };
  /** Loans from a partner lender (Nigeria). null: not offered in this market yet. */
  lending: Lending | null;
  /** claimable_code cash-outs: agents can claim at once; the user can take it back after returnAfterDays. */
  cashOutCode: { digits: number; returnAfterDays: number; maxAttempts: number } | null;
  /** Hours a helper's or agent's cash-in waits for the user's Yes before it expires. */
  cashInExpiryHours: number;
  /** App screens, in bottom-nav order; the app picks screens and wording from this. */
  screens: Screen[];
  record: "attested" | "native";
  /** Money moves up to this amount (major units) are confirmed by a spoken or tapped Yes; above it, the PIN, typed on the app's PIN pad (never spoken). */
  pinThreshold: number;
  /** Most a user may pay out per day (major units), across payments and group contributions. */
  payDailyLimit: number;
  idCheck: "partner_kyc_mock" | "nin_mock";
  /** Tiered KYC (modelled on Nigeria's tiers; the partner sets the exact limits). Tier 0 = sign-up not finished: no money moves. */
  kyc: Kyc;
  /** Sign-up: phone codes, and the test-number range whose sign-ups can be re-run (the old test person is archived, never deleted). */
  onboarding: { phoneCodeDigits: number; phoneCodeTtlSecs: number; maxCodeAttempts: number; maxCodesPerSession: number; demoPhonePrefix: string; phonePattern: string; phoneHint: string };
  /** Bank transfer in: each wallet gets a virtual account number at the partner bank (simulated). */
  virtualAccount: { bankLabel: string; digits: number } | null;
  /**
   * Send to a bank account (simulated): NGNT goes to the partner's anchor, which pays the account.
   * The bank list is generic and fictional; the account-name lookup is simulated.
   */
  bankSend: { banks: { code: string; name: string }[]; accountDigits: number } | null;
  /** Voice-agent tools. */
  services: string[];
  /** Services used by helpers (group leaders, correspondents, agents), never by the voice agent. */
  helperServices: string[];
}

/**
 * The lending model (illustrative numbers; the partner lender sets the real ones). Amounts in major
 * units (naira); rates in basis points.
 *
 * Unlock: account open `weeks`+, money in during `activeWeeks` of them, `minQualifyingTx`
 * qualifying transactions (circular or back-and-forth transfers don't count), identity verified,
 * good standing, and one verified asset (the collateral). Before that she sees her progress, and an
 * estimate that is not an offer. Never the words "rejected" or "not eligible".
 *
 * The offer is the lowest of: this step's ladder amount, what she can afford, and her verified
 * assets' lending value divided by the collateral this step needs.
 */
export interface Lending {
  unlock: { weeks: number; activeWeeks: number; minQualifyingTx: number };
  /** Why she got it: weights (percent) of the score shown on the offer. */
  weights: { activity: number; assets: number; savings: number };
  /** The rewards ladder: each repaid loan moves her up one step (the last step repeats). */
  ladder: { max: number; costBps: number; collateralPct: number; approval: string }[];
  /** Repayment: repayBps of every money-in, plus at least `minimum` every `everyDays`. */
  repay: { fromMoneyInBps: number; minimum: number; everyDays: number };
  /** Affordability: what she can repay over `weeks` from repayBps of her typical weekly money-in, plus the minimums. Rounded down to `roundTo`. */
  affordability: { weeks: number; roundTo: number };
  /** Lending value of a verified asset, by verification level (basis points of its estimated value). */
  lendingValueBps: Record<AssetLevel, number>;
  /** Missed payment path: a reminder with `graceDays`, then late (restructure offered), then borrowing frozen. */
  graceDays: number;
  /** "I need more time": the next minimum moves by this many days; new borrowing pauses until repaid. */
  extensionDays: number;
  /** Restructure: a smaller minimum over a longer time. */
  restructuredMinimum: number;
  /** The partner lender, as she sees it. */
  lenderLabel: string;
  /**
   * Ajo vouches (piece 10): members in good standing (verified ID, `minWeeks`+ with Plus, every
   * ajo payment on time) vouch for another member's next loan. With `min` or more, the collateral
   * her offer needs is at most `collateralPct`. A voucher whose vouched loan defaults can't vouch
   * for `banMonths` months; no money is ever taken from her.
   */
  vouch?: { min: number; collateralPct: number; minWeeks: number; banMonths: number; max: number };
}

export type AssetLevel = "registered" | "evidence_verified" | "community_verified" | "independently_verified";

export interface Tier {
  /** What she must give for this tier. */
  needs: ("name" | "phone" | "selfie" | "id_document")[];
  /** Most she may send out per day (major units). */
  dailyLimit: number;
  /** Most her wallet may hold (major units). Money that would take her over it is refused. */
  balanceLimit: number;
  /** Advances unlock at this tier, after advance.eligibleAfterWeeks as a member. */
  advances: boolean;
}

export interface Kyc {
  tiers: { 1: Tier; 2: Tier };
  /** The ID number checked for tier 2, typed on screen only (never spoken). Only a hash and the last 4 digits are kept. null: done by the partner bank, not in the app. */
  idDocument: { name: string; digits: number; wrongTestNumber: string } | null;
}

export type Screen = "home" | "pay" | "group" | "advance" | "loan" | "record" | "add_money" | "add_cash" | "cash_out" | "settings";

export const SERVICES: readonly string[] = [
  "get_user",
  "start_onboarding",
  "onboarding_status",
  "set_profile",
  "send_phone_code",
  "verify_phone_code",
  "verify_identity",
  "create_wallet",
  "set_trusted_contact",
  "set_pin",
  "get_balance",
  "what_arrived",
  "set_auto_save",
  "prepare_pay",
  "prepare_save",
  "prepare_cashout",
  "prepare_group_contribution",
  "prepare_advance",
  "confirm_action",
  "reject_action",
  "group_status",
  "my_record",
  "share_record",
];

export const HELPER_SERVICES: readonly string[] = ["record_cash_in"];

export const MARKETS: Record<MarketId, Market> = {
  in: {
    id: "in",
    country: "India",
    currency: { code: "INR", symbol: "₹", onChain: false },
    languages: ["ta", "en"],
    custody: "partner_bank",
    usdBalance: false,
    domesticRail: "upi_sim",
    cashIn: ["helper_record"],
    cashOut: ["agent_guidance"],
    helperFloatLimit: 20000,
    incomingSources: ["state_transfer", "wages", "family_abroad", "cash"],
    inboundCorridors: ["CA"],
    autoSave: { enabled: true, defaultBps: 1000 },
    groupSavings: { mode: "record", localName: "seettu" },
    advance: { min: 2000, max: 10000, feeBps: 150, eligibleAfterWeeks: 8, repayFromCashInBps: 1000 },
    lending: null,
    cashOutCode: null,
    cashInExpiryHours: 24,
    screens: ["home", "pay", "group", "advance", "record", "add_money", "settings"],
    record: "attested",
    pinThreshold: 500,
    payDailyLimit: 10000,
    idCheck: "partner_kyc_mock",
    kyc: {
      tiers: {
        1: { needs: ["name", "phone", "selfie"], dailyLimit: 5000, balanceLimit: 10000, advances: false },
        // Full KYC is done by the partner bank (Indian users never give an ID number to Plus; no Aadhaar).
        2: { needs: ["name", "phone", "selfie", "id_document"], dailyLimit: 10000, balanceLimit: 200000, advances: true },
      },
      idDocument: null,
    },
    onboarding: { phoneCodeDigits: 6, phoneCodeTtlSecs: 600, maxCodeAttempts: 5, maxCodesPerSession: 5, demoPhonePrefix: "+9170000", phonePattern: "^\\+91[0-9]{10}$", phoneHint: "+91 70000 00101" },
    virtualAccount: null,
    bankSend: null,
    services: [...SERVICES],
    helperServices: [...HELPER_SERVICES],
  },
  ng: {
    id: "ng",
    country: "Nigeria",
    currency: { code: "NGN", symbol: "₦", onChain: true },
    // English covers Nigerian Pidgin.
    languages: ["en", "yo", "ha", "ig"],
    custody: "stellar_account",
    usdBalance: true,
    domesticRail: "stellar",
    cashIn: ["agent_float", "bank_transfer"],
    cashOut: ["claimable_code"],
    helperFloatLimit: 500000,
    incomingSources: ["bank", "cash", "plus_user"],
    inboundCorridors: [],
    autoSave: { enabled: true, defaultBps: 1000 },
    groupSavings: { mode: "pooled", localName: "ajo" },
    // The 1.5% advance is retired from the app (its contract functions stay); loans replace it.
    advance: { min: 5000, max: 30000, feeBps: 150, eligibleAfterWeeks: 8, repayFromCashInBps: 1000 },
    lending: {
      unlock: { weeks: 6, activeWeeks: 4, minQualifyingTx: 12 },
      weights: { activity: 40, assets: 35, savings: 25 },
      ladder: [
        { max: 30000, costBps: 600, collateralPct: 150, approval: "within a day" },
        { max: 50000, costBps: 500, collateralPct: 125, approval: "within hours" },
        { max: 80000, costBps: 450, collateralPct: 100, approval: "in minutes" },
        { max: 80000, costBps: 450, collateralPct: 50, approval: "in minutes" },
      ],
      repay: { fromMoneyInBps: 1000, minimum: 2500, everyDays: 14 },
      affordability: { weeks: 12, roundTo: 5000 },
      lendingValueBps: { registered: 0, evidence_verified: 3000, community_verified: 4500, independently_verified: 6000 },
      graceDays: 3,
      extensionDays: 14,
      restructuredMinimum: 1500,
      lenderLabel: "Partner lender (simulated)",
      vouch: { min: 2, collateralPct: 100, minWeeks: 6, banMonths: 6, max: 10 },
    },
    cashOutCode: { digits: 6, returnAfterDays: 7, maxAttempts: 5 },
    cashInExpiryHours: 24,
    screens: ["home", "add_cash", "pay", "group", "loan", "cash_out", "record", "settings"],
    record: "native",
    pinThreshold: 5000,
    payDailyLimit: 200000,
    idCheck: "nin_mock",
    kyc: {
      tiers: {
        // Like CBN tier 1: name, phone and a photo; low limits; no advances.
        1: { needs: ["name", "phone", "selfie"], dailyLimit: 50000, balanceLimit: 300000, advances: false },
        // Like CBN tier 2: NIN checked; higher limits; advances after eligibleAfterWeeks.
        2: { needs: ["name", "phone", "selfie", "id_document"], dailyLimit: 200000, balanceLimit: 500000, advances: true },
      },
      // Mock registry: any 11 digits pass except this test number, which is always "not found".
      idDocument: { name: "NIN", digits: 11, wrongTestNumber: "00000000000" },
    },
    onboarding: { phoneCodeDigits: 6, phoneCodeTtlSecs: 600, maxCodeAttempts: 5, maxCodesPerSession: 5, demoPhonePrefix: "+2347000000", phonePattern: "^\\+234[0-9]{10}$", phoneHint: "0700 000 0101" },
    virtualAccount: { bankLabel: "Partner bank (simulated)", digits: 10 },
    // Fictional banks for the demo (codes D01-D06 are not real bank codes).
    bankSend: {
      accountDigits: 10,
      banks: [
        { code: "D01", name: "Ironwood Bank" },
        { code: "D02", name: "Harmattan Bank" },
        { code: "D03", name: "Lagoon Trust Bank" },
        { code: "D04", name: "Kolanut Bank" },
        { code: "D05", name: "Savanna Microfinance Bank" },
        { code: "D06", name: "Market Women's Cooperative Bank" },
      ],
    },
    services: [...SERVICES],
    helperServices: [...HELPER_SERVICES],
  },
};

export const MARKET_IDS: readonly MarketId[] = ["in", "ng"];

/** The limits for a KYC tier; tier 0 (sign-up not finished) may not move money. */
export function tierOf(id: MarketId, tier: number): Tier | null {
  const t = getMarket(id).kyc.tiers;
  return tier >= 2 ? t[2] : tier === 1 ? t[1] : null;
}

/** A test number: its code shows on screen and signing up again archives the old test person. */
export function isDemoPhone(id: MarketId, phone: string): boolean {
  return phone.startsWith(getMarket(id).onboarding.demoPhonePrefix);
}

export function getMarket(id: MarketId): Market {
  const market = MARKETS[id];
  if (!market) throw new Error(`Unknown market: ${id}`);
  return market;
}

// Indian grouping: last three digits, then groups of two (1,00,000).
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) parts.unshift(rest);
  return `${parts.join(",")},${last3}`;
}

// International grouping: groups of three (100,000).
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Format minor units (paise or kobo) as rupees or naira.
 * Whole amounts print without decimals (₹1,00,000); otherwise two decimals (₹1,00,000.50).
 * Integer-only: never converts through floating point.
 */
export function formatMoney(minorUnits: bigint, marketId: MarketId): string {
  const market = getMarket(marketId);
  const negative = minorUnits < 0n;
  const abs = negative ? -minorUnits : minorUnits;
  const major = abs / 100n;
  const minor = abs % 100n;
  const digits = major.toString();
  const grouped = market.currency.code === "INR" ? groupIndian(digits) : groupThousands(digits);
  const fraction = minor === 0n ? "" : `.${minor.toString().padStart(2, "0")}`;
  return `${negative ? "-" : ""}${market.currency.symbol}${grouped}${fraction}`;
}

/**
 * Amount for speech: "2,350 rupees", "50,000 naira" (no symbol, so a voice never guesses the
 * currency; an India user never hears "dollars"). Same integer-only rules as formatMoney.
 */
export function formatSpokenMoney(minorUnits: bigint, marketId: MarketId): string {
  const symbol = getMarket(marketId).currency.symbol;
  const text = formatMoney(minorUnits, marketId).replace(symbol, "");
  const unit = marketId === "in" ? "rupees" : "naira";
  return `${text} ${unit}`;
}
