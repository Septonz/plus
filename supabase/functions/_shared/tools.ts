// Plus tools: one code path for the voice agent (ElevenLabs webhooks) and the app (taps).
//
// Every tool gets a Context: the user (resolved by the router, never from the LLM), the channel
// ("voice" or "app"), a Store (database access) and the arguments. Each returns { text, ...fields }:
// `text` is short English the agent says in the user's language (amounts already in words, always
// "rupees" for India), the fields are for the app.
//
// Money rules (CLAUDE.md): every money action is prepare -> confirm. prepare_* only creates a
// pending action and returns the read-back; confirm_action executes it once (atomic claim in the
// database, stored result on retries). Above the market's PIN threshold only the app's PIN pad
// can confirm: the voice channel can neither confirm it nor pass a PIN.
import { advanceAllowed, spendAllowed } from "./tiers.ts";
import { formatMoney, formatSpokenMoney, getMarket, type MarketId } from "./markets.ts";
import { matchPayee, parseMajorAmount, type Payee } from "./payees.ts";
import type { PinOutcome } from "./pin.ts";

export type Channel = "voice" | "app";

export interface User {
  id: string;
  /** A named demo person (shared demo password): DEMO_LOGINS_ENABLED and the rate limit apply. */
  demo_login?: boolean;
  /** Piece 12: a guest trader's pool place (public test mode); null for everyone else. */
  guest_slot?: number | null;
  market_id: MarketId;
  name: string | null;
  language: string;
  kyc_tier: number;
  stellar_pub: string | null;
  auto_save_bps: number;
  ref_hash: string | null;
  trusted_contact_phone: string | null;
  /** When she joined Plus (advances open after the market's eligibleAfterWeeks). */
  member_since?: string | null;
  /** Nigeria: her account number at the partner bank (simulated), for transfers in. */
  virtual_account?: string | null;
}

export interface Account {
  balance_paise: number | string;
  savings_paise: number | string;
  bank_name: string;
}

export interface Action {
  id: string;
  user_id: string;
  kind: string;
  params: Record<string, unknown>;
  readback: string;
  status: "pending" | "executing" | "done" | "failed" | "expired" | "rejected";
  result: Record<string, unknown> | null;
  expires_at: string;
  created_by: "user" | "helper";
  created_at: string;
}

export interface Tx {
  id: string;
  kind: string;
  source: string | null;
  amount: number | string;
  created_at: string;
  chain_tx_hash: string | null;
}

export interface CashIn {
  cash_event_id: string;
  pending_action_id: string | null;
  amount: number | string;
  helper_name: string;
  created_at: string;
}

export interface Group {
  id: string;
  name: string;
  mode: "record" | "pooled";
  onchain_id: number | null;
  amount: number | string;
  period_secs: number;
  next_due: string | null;
  /** Set when a round was started by hand (pnpm demo:reset): earlier contributions don't count for it. */
  round_started_at?: string | null;
}

export interface Member {
  name: string | null;
  position: number;
  member_ref: string | null;
  user_id: string | null;
}

export interface ChainEvent {
  type: string;
  tx_hash: string;
  ledger: number;
  topics: unknown[];
  data: Record<string, unknown> | null;
  created_at: string;
}

export interface Store {
  account(userId: string): Promise<Account | null>;
  hasPin(userId: string): Promise<boolean>;
  verifyPin(userId: string, pin: string): Promise<PinOutcome>;
  setPin(userId: string, pin: string): Promise<void>;
  payees(userId: string): Promise<Payee[]>;
  /** Paise paid out (payments and group contributions) since the given instant. */
  paidSince(userId: string, sinceIso: string): Promise<bigint>;
  createAction(a: { user_id: string; kind: string; params: Record<string, unknown>; readback: string; ttl_secs: number }): Promise<Action>;
  action(id: string, userId: string): Promise<Action | null>;
  pendingActions(userId: string): Promise<Action[]>;
  executeAction(id: string, userId: string): Promise<Action>;
  rejectAction(id: string, userId: string): Promise<Action>;
  incoming(userId: string, sinceIso: string, limit: number): Promise<Tx[]>;
  /** Newest first; rows hidden from her history are left out unless includeHidden. */
  transactions(userId: string, limit: number, includeHidden?: boolean): Promise<Tx[]>;
  awaitingCashIns(userId: string): Promise<CashIn[]>;
  /** Contract events about this on-chain ref (attested, contribution_recorded, limit_set, advance_*). */
  chainEventsForRef(refHex: string): Promise<ChainEvent[]>;
  /** Outbox rows for this ref not yet on-chain. */
  chainPending(refHex: string): Promise<number>;
  updateUser(userId: string, patch: { language?: string; trusted_contact_phone?: string | null }): Promise<void>;
  /** Nigeria only: balances from the user's own Stellar account. */
  stellarBalance?(user: User): Promise<ToolResult>;
}

export interface Context {
  user: User;
  channel: Channel;
  store: Store;
  args: Record<string, unknown>;
  now?: Date;
  /** Stellar Expert base for links, e.g. https://stellar.expert/explorer/testnet */
  explorer?: string;
  contractId?: string;
}

export type ToolResult = { text: string; [k: string]: unknown };
export type Tool = (ctx: Context) => Promise<ToolResult>;

export const ACTION_TTL_SECS = 10 * 60;
export const MAX_AUTO_SAVE_PERCENT = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const big = (v: number | string | bigint) => BigInt(v);
const show = (minor: number | string | bigint, m: MarketId) => formatMoney(big(minor), m);
const say = (minor: number | string | bigint, m: MarketId) => formatSpokenMoney(big(minor), m);
/** On-chain i128 (7 decimals) -> minor units (2 decimals). */
const chainToMinor = (v: unknown) => BigInt(String(v ?? "0")) / 100000n;

const TZ_OFFSET_MIN: Record<MarketId, number> = { in: 330, ng: 60 };

/** Start of "today" in the market's time zone, as an ISO instant. */
export function dayStart(market: MarketId, now: Date): string {
  const off = TZ_OFFSET_MIN[market] * 60_000;
  const local = now.getTime() + off;
  return new Date(local - (local % 86_400_000) - off).toISOString();
}

function whenSpoken(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

const SOURCE_NAMES: Record<string, string> = {
  state_transfer: "the state transfer",
  wages: "wages",
  family_abroad: "family abroad",
  cash: "cash",
  deposit: "a deposit",
};
/** Contract AttestKind: Received = 0, Saved = 1, Paid = 2. */
const ATTEST_KINDS = ["received", "saved", "paid"];
const LANGUAGE_NAMES: Record<string, string> = { ta: "Tamil", en: "English", yo: "Yoruba", ha: "Hausa", ig: "Igbo" };

function amountOf(a: Action): bigint {
  const v = a.params.amount;
  return typeof v === "number" || typeof v === "string" ? BigInt(v) : 0n;
}

/** Does confirming this action need the PIN (money leaving, above the threshold)? */
export function needsPin(a: Action, market: MarketId): boolean {
  if (a.kind !== "pay" && a.kind !== "group_contribution") return false;
  return amountOf(a) > BigInt(getMarket(market).pinThreshold) * 100n;
}

function confirmHint(requiresPin: boolean): string {
  return requiresPin
    ? "Ask her to check her screen and type her PIN there. Never ask for the PIN out loud."
    : "Ask her to check her screen and tap Yes, or say yes.";
}

function actionFields(a: Action, market: MarketId) {
  return {
    action_id: a.id,
    kind: a.kind,
    readback: a.readback,
    requires_pin: needsPin(a, market),
    status: a.status,
    expires_at: a.expires_at,
  };
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

export const getUser: Tool = async ({ user, store }) => {
  const market = getMarket(user.market_id);
  const [hasPin, cash, pending] = await Promise.all([
    store.hasPin(user.id),
    store.awaitingCashIns(user.id),
    store.pendingActions(user.id),
  ]);
  const parts = [
    `This is ${user.name ?? "this caller"}. Language: ${LANGUAGE_NAMES[user.language] ?? user.language}. ${market.country}.`,
    `Auto-save is ${user.auto_save_bps / 100}% of money that arrives. PIN ${hasPin ? "is set" : "is not set yet"}.`,
  ];
  for (const c of cash) {
    parts.push(`Waiting for her answer first: ${c.helper_name} says she gave ${say(c.amount, user.market_id)} in cash. Ask if that is right.`);
  }
  return {
    text: parts.join(" "),
    known: true,
    user_id: user.id,
    name: user.name,
    language: user.language,
    market: user.market_id,
    currency: market.currency.code,
    kyc_tier: user.kyc_tier,
    auto_save_bps: user.auto_save_bps,
    has_pin: hasPin,
    cash_ins_waiting: cash.map((c) => ({ ...c, amount_text: show(c.amount, user.market_id) })),
    pending_actions: pending.map((a) => actionFields(a, user.market_id)),
  };
};

export const getBalance: Tool = async (ctx) => {
  const { user, store } = ctx;
  const market = getMarket(user.market_id);
  if (market.custody !== "partner_bank") {
    if (!store.stellarBalance) return { text: "Balance is not available.", has_account: false };
    return store.stellarBalance(user);
  }
  const acct = await store.account(user.id);
  if (!acct) return { text: "There is no bank account linked yet.", has_account: false };
  return {
    text: `She has ${say(acct.balance_paise, user.market_id)} to spend and ${say(acct.savings_paise, user.market_id)} saved, in her ${acct.bank_name} account.`,
    has_account: true,
    currency: market.currency.code,
    balance_minor: String(acct.balance_paise),
    savings_minor: String(acct.savings_paise),
    balance_text: show(acct.balance_paise, user.market_id),
    savings_text: show(acct.savings_paise, user.market_id),
    bank_name: acct.bank_name,
  };
};

export const whatArrived: Tool = async ({ user, store, now = new Date() }) => {
  const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const [cash, incoming] = await Promise.all([store.awaitingCashIns(user.id), store.incoming(user.id, since, 5)]);
  const m = user.market_id;
  const awaiting = cash.map((c) => ({
    ...c,
    amount_minor: String(c.amount),
    amount_text: show(c.amount, m),
    when: whenSpoken(c.created_at, now),
  }));
  const arrived = incoming.map((t) => ({
    amount_minor: String(t.amount),
    amount_text: show(t.amount, m),
    source: t.source,
    when: whenSpoken(t.created_at, now),
    at: t.created_at,
    on_stellar: t.chain_tx_hash !== null,
  }));
  const parts: string[] = [];
  // Cash waiting for her Yes or No comes first.
  for (const c of cash) {
    parts.push(`${c.helper_name} says she gave ${say(c.amount, m)} in cash ${whenSpoken(c.created_at, now)}. It counts only after she says it is right. Ask her: is that right?`);
  }
  if (incoming.length === 0) parts.push("No money has arrived in the last two weeks.");
  else {
    parts.push(
      "Arrived: " +
        incoming.map((t) => `${say(t.amount, m)} from ${SOURCE_NAMES[t.source ?? ""] ?? t.source ?? "a payment"}, ${whenSpoken(t.created_at, now)}`)
          .join("; ") + ".",
    );
  }
  return { text: parts.join(" "), awaiting_confirmation: awaiting, arrived };
};

export const myRecord: Tool = async ({ user, store, explorer, contractId }) => {
  const m = user.market_id;
  // Totals cover everything; the list shows her recent history (piece 11: not the reset's rows).
  const [txs, visible, events, waiting] = await Promise.all([
    store.transactions(user.id, 500, true),
    store.transactions(user.id, 30),
    user.ref_hash ? store.chainEventsForRef(user.ref_hash) : Promise.resolve([] as ChainEvent[]),
    user.ref_hash ? store.chainPending(user.ref_hash) : Promise.resolve(0),
  ]);
  let received = 0n, saved = 0n, paid = 0n;
  for (const t of txs) {
    const a = big(t.amount);
    if (t.kind === "incoming") received += a;
    else if (t.kind === "saved") saved += -a;
    else if (t.kind === "group_contribution") continue; // community savings (retired in piece 13): history only
    else if (t.kind !== "adjustment" && a < 0n) paid += -a; // demo resets are not spending
  }
  const recordEvents = events.filter((e) => e.type === "attested" || e.type === "contribution_recorded");
  const link = (hash: string) => (explorer ? `${explorer}/tx/${hash}` : null);
  const history = recordEvents.slice(0, 50).map((e) => ({
    type: e.type,
    kind: e.type === "contribution_recorded" ? "group" : ATTEST_KINDS[Number(e.data?.kind)] ?? "other",
    amount_minor: String(chainToMinor(e.data?.amount)),
    amount_text: show(chainToMinor(e.data?.amount), m),
    at: e.created_at,
    tx_hash: e.tx_hash,
    url: link(e.tx_hash),
  }));
  const recordUrl = explorer && contractId ? `${explorer}/contract/${contractId}` : null;
  return {
    text: `Her record in Plus: ${say(received, m)} received, ${say(saved, m)} saved, ${say(paid, m)} paid. ` +
      `${recordEvents.length} entries are confirmed on Stellar` +
      (waiting > 0 ? `, ${waiting} more on the way.` : ".") + " Her name is never on the chain, only a code.",
    totals: {
      received_minor: String(received),
      saved_minor: String(saved),
      paid_minor: String(paid),
      received_text: show(received, m),
      saved_text: show(saved, m),
      paid_text: show(paid, m),
    },
    confirmed_on_stellar: recordEvents.length,
    waiting_for_stellar: waiting,
    history,
    recent: visible.filter((t) => t.kind !== "adjustment").map((t) => ({
      id: t.id,
      kind: t.kind,
      source: t.source,
      amount_minor: String(t.amount),
      amount_text: show(t.amount, m),
      at: t.created_at,
      on_stellar: t.chain_tx_hash !== null,
      url: t.chain_tx_hash ? link(t.chain_tx_hash) : null,
    })),
    record_url: recordUrl,
  };
};

export const advanceStatus: Tool = async ({ user, store }) => {
  const m = user.market_id;
  const rules = getMarket(m).advance;
  const events = user.ref_hash ? await store.chainEventsForRef(user.ref_hash) : [];
  // Newest first: the latest limit_set is the current limit.
  const limitEv = events.find((e) => e.type === "limit_set");
  const onchainLimit = limitEv ? chainToMinor(limitEv.data?.limit ?? limitEv.data?.value) : 0n;
  const maxMinor = BigInt(rules.max) * 100n;
  const minMinor = BigInt(rules.min) * 100n;
  const limit = onchainLimit > maxMinor ? maxMinor : onchainLimit;
  const owed = events.reduce((s, e) => {
    if (e.type === "advance_recorded") return s + chainToMinor(e.data?.owed);
    if (e.type === "repayment_recorded") return s - chainToMinor(e.data?.amount);
    return s;
  }, 0n);
  const blocked = advanceAllowed(user);
  const eligible = limit >= minMinor && owed <= 0n && !blocked;
  const fee = (a: bigint) => (a * BigInt(rules.feeBps)) / 10000n;
  const options: { amount_minor: string; amount_text: string; cost_minor: string; cost_text: string }[] = [];
  for (let a = minMinor; a <= limit; a += 100000n) {
    options.push({ amount_minor: String(a), amount_text: show(a, m), cost_minor: String(fee(a)), cost_text: show(fee(a), m) });
  }
  if (limit >= minMinor && options.at(-1)?.amount_minor !== String(limit)) {
    options.push({ amount_minor: String(limit), amount_text: show(limit, m), cost_minor: String(fee(limit)), cost_text: show(fee(limit), m) });
  }
  const text = owed > 0n
    ? `She has an advance open: ${say(owed, m)} still to repay.`
    : eligible
    ? `She can take an advance of up to ${say(limit, m)}. It costs ${rules.feeBps / 100}%: ${say(fee(limit), m)} on ${say(limit, m)}. No advance is open.`
    : blocked ? blocked.text
    : `She can't take an advance yet. It opens after ${rules.eligibleAfterWeeks} weeks of money coming in through Plus.`;
  return {
    text,
    eligible,
    limit_minor: String(limit),
    limit_text: show(limit, m),
    fee_bps: rules.feeBps,
    options,
    owed_minor: String(owed > 0n ? owed : 0n),
    owed_text: show(owed > 0n ? owed : 0n, m),
    open: owed > 0n,
  };
};

// ---------------------------------------------------------------------------
// Prepare tools (money moves only after confirm_action)
// ---------------------------------------------------------------------------

function refuse(text: string, error: string, extra: Record<string, unknown> = {}): ToolResult {
  return { text, ok: false, error, ...extra };
}

export const setAutoSave: Tool = async ({ user, store, args }) => {
  const raw = typeof args.percent === "string" ? args.percent.replace("%", "").trim() : args.percent;
  const percent = typeof raw === "number" ? raw : /^\d+$/.test(String(raw ?? "")) ? Number(raw) : NaN;
  if (!Number.isInteger(percent) || percent < 0 || percent > MAX_AUTO_SAVE_PERCENT) {
    return refuse(`Auto-save can be from 0 to ${MAX_AUTO_SAVE_PERCENT} percent, in whole numbers.`, "invalid_percent");
  }
  const bps = percent * 100;
  const readback = `Save ${percent}% of money that arrives (now ${user.auto_save_bps / 100}%)`;
  const a = await store.createAction({ user_id: user.id, kind: "set_auto_save", params: { bps, percent }, readback, ttl_secs: ACTION_TTL_SECS });
  return {
    text: `Read back: from now on, save ${percent} percent of money that arrives; it is ${user.auto_save_bps / 100} percent now. ${confirmHint(false)}`,
    ok: true,
    ...actionFields(a, user.market_id),
  };
};

export const preparePay: Tool = async ({ user, store, args, now = new Date() }) => {
  const m = user.market_id;
  const amount = parseMajorAmount(args.amount);
  if (amount === null) return refuse("How much should she pay? Ask for the amount in rupees.", "invalid_amount");
  const spoken = typeof args.payee === "string" ? args.payee : "";
  const payees = await store.payees(user.id);
  if (payees.length === 0) return refuse("She has no saved payees yet.", "no_payees");
  const match = matchPayee(spoken, payees);
  if (match.kind !== "match") {
    const names = match.options.map((p) => p.name);
    return refuse(
      match.kind === "ambiguous"
        ? `Which one: ${names.join(" or ")}? Ask her; don't guess.`
        : `"${spoken}" is not one of her saved payees: ${names.join(", ")}. Ask which one she means.`,
      match.kind === "ambiguous" ? "ambiguous_payee" : "unknown_payee",
      { options: match.options.map((p) => ({ id: p.id, name: p.name })) },
    );
  }
  const payee = match.payee;
  const [acct, paidToday] = await Promise.all([store.account(user.id), store.paidSince(user.id, dayStart(m, now))]);
  if (!acct) return refuse("There is no bank account linked yet.", "no_account");
  if (big(acct.balance_paise) < amount) {
    return refuse(`Not enough money: she has ${say(acct.balance_paise, m)} to spend.`, "insufficient_funds", {
      balance_text: show(acct.balance_paise, m),
    });
  }
  // Her KYC tier's daily limit (the lower of it and the market's).
  const overLimit = spendAllowed(user, amount, paidToday);
  if (overLimit) return overLimit;
  const readback = `${show(amount, m)} to ${payee.name}`;
  const a = await store.createAction({
    user_id: user.id,
    kind: "pay",
    params: { amount: String(amount), payee_id: payee.id, payee_name: payee.name, upi_handle: payee.upi_handle ?? null },
    readback,
    ttl_secs: ACTION_TTL_SECS,
  });
  const pin = needsPin(a, m);
  return {
    text: `Read back: ${say(amount, m)} to ${payee.name}. ${confirmHint(pin)}`,
    ok: true,
    ...actionFields(a, m),
    payee: { id: payee.id, name: payee.name },
    amount_text: show(amount, m),
  };
};

// ---------------------------------------------------------------------------
// Confirm / reject
// ---------------------------------------------------------------------------

function resultText(a: Action, user: User, balance?: Account | null): string {
  const m = user.market_id;
  const r = a.result ?? {};
  const bal = balance ? ` She now has ${say(balance.balance_paise, m)} to spend.` : "";
  switch (a.status) {
    case "done":
      switch (a.kind) {
        case "pay":
          return `Done: paid ${say(String(r.amount ?? a.params.amount), m)} to ${String(r.payee_name ?? a.params.payee_name)}.${bal}`;
        case "set_auto_save":
          return `Done: she now saves ${Number(r.bps ?? a.params.bps) / 100}% of money that arrives.`;
        case "confirm_cash_in":
          return `Done: ${say(String(r.amount ?? a.params.amount), m)} cash from ${String(r.helper_name ?? a.params.helper_name)} is in her account.${bal}`;
      }
      return "Done.";
    case "failed":
      return r.error === "insufficient_funds"
        ? `It didn't go through: not enough money.${bal}`
        : "It didn't go through. Nothing was taken from her account.";
    case "rejected":
      return a.kind === "confirm_cash_in" ? "Okay, that cash is marked as not received." : "Okay, cancelled. Nothing was paid.";
    case "expired":
      return "That request has expired. Nothing happened; start again if she still wants it.";
    default:
      return "It is still being processed.";
  }
}

export const confirmAction: Tool = async ({ user, store, args, channel }) => {
  const id = typeof args.action_id === "string" ? args.action_id : "";
  const pin = typeof args.pin === "string" ? args.pin : undefined;
  if (channel === "voice" && pin !== undefined) {
    // A PIN must never travel through the voice agent.
    return refuse("Never take the PIN by voice. Ask her to type it on her screen.", "pin_not_allowed_by_voice");
  }
  const a = id ? await store.action(id, user.id) : null;
  if (!a) return refuse("I couldn't find that request. Start again.", "not_found");

  if (a.status === "pending") {
    if (needsPin(a, user.market_id)) {
      if (channel === "voice") {
        return {
          text: "This amount needs her PIN. Ask her to type her PIN on the screen; you can't confirm it by voice.",
          ok: false,
          error: "pin_required_on_screen",
          ...actionFields(a, user.market_id),
        };
      }
      if (pin === undefined) return refuse("Type your PIN to confirm.", "pin_required", actionFields(a, user.market_id));
      const check = await store.verifyPin(user.id, pin);
      if (!check.ok) {
        if (check.outcome === "not_set") return refuse("Set a PIN in Settings first.", "pin_not_set");
        if (check.outcome === "locked") {
          return refuse("Too many wrong PINs. Try again in 15 minutes.", "pin_locked", { locked_until: check.lockedUntil });
        }
        return refuse(`Wrong PIN. ${check.attemptsLeft} ${check.attemptsLeft === 1 ? "try" : "tries"} left.`, "pin_wrong", {
          attempts_left: check.attemptsLeft,
        });
      }
    }
  }
  // Executes once; every retry (or a second device) gets the stored result back.
  const done = await store.executeAction(a.id, user.id);
  const showBalance = done.kind !== "set_auto_save" && (done.status === "done" || done.status === "failed");
  const acct = showBalance && getMarket(user.market_id).custody === "partner_bank" ? await store.account(user.id) : null;
  return {
    text: resultText(done, user, acct),
    ok: done.status === "done",
    action_id: done.id,
    kind: done.kind,
    status: done.status,
    result: done.result,
    balance_text: acct ? show(acct.balance_paise, user.market_id) : undefined,
    savings_text: acct ? show(acct.savings_paise, user.market_id) : undefined,
  };
};

export const rejectAction: Tool = async ({ user, store, args }) => {
  const id = typeof args.action_id === "string" ? args.action_id : "";
  const a = id ? await store.action(id, user.id) : null;
  if (!a) return refuse("I couldn't find that request.", "not_found");
  const done = await store.rejectAction(a.id, user.id);
  return { text: resultText(done, user), ok: done.status === "rejected", action_id: done.id, kind: done.kind, status: done.status };
};

// ---------------------------------------------------------------------------
// App-only tools (refused on the voice channel)
// ---------------------------------------------------------------------------

export const setPin: Tool = async ({ user, store, args, channel }) => {
  if (channel !== "app") return refuse("A PIN can only be set on the screen.", "app_only");
  const pin = typeof args.pin === "string" ? args.pin : "";
  if (!/^\d{4,6}$/.test(pin)) return refuse("The PIN must be 4 to 6 digits.", "invalid_pin");
  if (await store.hasPin(user.id)) {
    const current = typeof args.current_pin === "string" ? args.current_pin : "";
    const check = await store.verifyPin(user.id, current);
    if (!check.ok) {
      return refuse(check.outcome === "locked" ? "Too many wrong PINs. Try again in 15 minutes." : "Your current PIN is wrong.", `current_pin_${check.outcome}`);
    }
  }
  await store.setPin(user.id, pin);
  return { text: "PIN saved.", ok: true };
};

export const updateSettings: Tool = async ({ user, store, args, channel }) => {
  if (channel !== "app") return refuse("Change this on the screen.", "app_only");
  const patch: { language?: string; trusted_contact_phone?: string | null } = {};
  if (args.language !== undefined) {
    if (!getMarket(user.market_id).languages.includes(String(args.language))) return refuse("Unknown language.", "invalid_language");
    patch.language = String(args.language);
  }
  if (args.trusted_contact_phone !== undefined) {
    const raw = String(args.trusted_contact_phone ?? "").replace(/[\s-]/g, "");
    if (raw === "") patch.trusted_contact_phone = null;
    else if (/^\+[1-9]\d{7,14}$/.test(raw)) patch.trusted_contact_phone = raw;
    else if (user.market_id === "in" && /^[6-9]\d{9}$/.test(raw)) patch.trusted_contact_phone = `+91${raw}`;
    else return refuse("Use a 10-digit mobile number.", "invalid_phone");
  }
  await store.updateUser(user.id, patch);
  return { text: "Saved.", ok: true, ...patch };
};

// ---------------------------------------------------------------------------
// Help: what she can do, by voice or on the screen
// ---------------------------------------------------------------------------

/** "What can I do?": everything the app does, each one also by voice, and what is waiting for her. */
export const help: Tool = async ({ user, store }) => {
  const m = user.market_id;
  const [cash, pending] = await Promise.all([store.awaitingCashIns(user.id), store.pendingActions(user.id)]);
  const pin = say(BigInt(getMarket(m).pinThreshold) * 100n, m);
  const can = [
    "check her balance, her savings and what came in",
    "pay a saved person: the flower wholesaler, the medical shop, and others",
    "change her auto-save percentage",
    "see her advance",
    "hear her record on Stellar",
    "change the app's language (Tamil or English) and her trusted person",
    "move to any screen: home, money, savings, advance, pay, activity, profile",
  ];
  const first: string[] = [];
  for (const c of cash) first.push(`${c.helper_name} says she gave ${say(c.amount, m)} in cash: is that right?`);
  for (const a of pending.filter((x) => x.status === "pending")) first.push(`waiting for her Yes: ${a.readback}`);
  return {
    text: `She can do all of this by voice or on her screen: ${can.join("; ")}. ` +
      `Money up to ${pin} she confirms by saying yes; above ${pin}, she types her PIN on the screen, never out loud.` +
      (first.length ? ` First, waiting now: ${first.join("; ")}.` : "") +
      " Offer two or three of these in one short sentence; don't read the whole list.",
    ok: true,
    can,
    voice_yes_up_to_text: show(BigInt(getMarket(m).pinThreshold) * 100n, m),
    waiting: first,
  };
};

// ---------------------------------------------------------------------------

/** Tools the voice agent may call. */
export const VOICE_TOOLS: Record<string, Tool> = {
  get_user: getUser,
  help,
  get_balance: getBalance,
  what_arrived: whatArrived,
  set_auto_save: setAutoSave,
  prepare_pay: preparePay,
  confirm_action: confirmAction,
  reject_action: rejectAction,
  my_record: myRecord,
  // Piece 13: community savings (seettu) is retired from the app and the agent; the groups tables and
  // the contract's group record functions stay, unused, for history.
  advance_status: advanceStatus,
};

/** Tools the app may call (the same functions, plus screen-only ones). */
export const APP_TOOLS: Record<string, Tool> = {
  ...VOICE_TOOLS,
  set_pin: setPin,
  update_settings: updateSettings,
};
