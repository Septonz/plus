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
  advance: { min: number; max: number; feeBps: number; eligibleAfterWeeks: number };
  record: "attested" | "native";
  /** Above this amount (major units) a payment needs the PIN, typed on the app's PIN pad. */
  pinThreshold: number;
  /** Most a user may pay out per day (major units), across payments and group contributions. */
  payDailyLimit: number;
  idCheck: "partner_kyc_mock" | "nin_mock";
  /** Voice-agent tools. */
  services: string[];
  /** Services used by helpers (group leaders, correspondents, agents), never by the voice agent. */
  helperServices: string[];
}

export const SERVICES: readonly string[] = [
  "get_user",
  "start_onboarding",
  "verify_id",
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
    advance: { min: 2000, max: 10000, feeBps: 150, eligibleAfterWeeks: 8 },
    record: "attested",
    pinThreshold: 2000,
    payDailyLimit: 10000,
    idCheck: "partner_kyc_mock",
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
    incomingSources: ["deposit", "cash"],
    inboundCorridors: [],
    autoSave: { enabled: true, defaultBps: 1000 },
    groupSavings: { mode: "pooled", localName: "ajo" },
    advance: { min: 5000, max: 30000, feeBps: 150, eligibleAfterWeeks: 8 },
    record: "native",
    pinThreshold: 20000,
    payDailyLimit: 200000,
    idCheck: "nin_mock",
    services: [...SERVICES],
    helperServices: [...HELPER_SERVICES],
  },
};

export const MARKET_IDS: readonly MarketId[] = ["in", "ng"];

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
