// Plus Nigeria tools: the user's Stellar wallet is her account. Same two-step rule as India
// (prepare -> confirm_action), but confirm_action only claims the action and queues the Stellar
// work in the chain outbox (one database transaction); it answers "sending" at once and the app
// shows the tick when chain-worker confirms the transaction on-chain.
//
// Voice and the app read balances only from the wallet_balances cache (refreshed from Horizon
// after every confirmed transaction and every minute). Contract state (ajo, advance, limit) is
// read from the contract's views. Amounts are kobo (bigint); spoken amounts are always naira.
import { collateralWords, type CreditAsset, type CreditLoan, creditPicture, type CreditWeek, lendingRules, levelWords } from "./lending.ts";
import { formatMoney, formatSpokenMoney, getMarket } from "./markets.ts";
import type { ChainAdvance, ContractReader } from "./ng-types.ts";
import { matchPayee, parseMajorAmount, type Payee } from "./payees.ts";
import type { PinOutcome } from "./pin.ts";
import { normalizePhone } from "./onboarding.ts";
import { advanceAllowed, receiveAllowed, spendAllowed, tierSummary } from "./tiers.ts";
import { type Action, ACTION_TTL_SECS, type CashIn, type Channel, dayStart, type ToolResult, type User } from "./tools.ts";

const M = "ng" as const;
const show = (kobo: bigint | number | string) => formatMoney(BigInt(kobo), M);
const say = (kobo: bigint | number | string) => formatSpokenMoney(BigInt(kobo), M);

export interface NgTx {
  id: string;
  kind: string;
  source: string | null;
  amount: number | string;
  status: "pending" | "completed" | "failed";
  created_at: string;
  chain_tx_hash: string | null;
  counterparty?: string | null;
}

/** Another Plus user, found by phone (for paying them). */
export interface PlusPeer {
  id: string;
  name: string | null;
  market_id: "in" | "ng";
  kyc_tier: number;
  stellar_pub: string | null;
}

export interface NgGroup {
  id: string;
  name: string;
  onchain_id: number;
  members: { name: string | null; position: number; user_id: string | null }[];
}

export interface CashOut {
  id: string;
  action_id: string;
  amount: number | string;
  status: "issued" | "redeemed" | "returned";
  expires_at: string;
  created_at: string;
  recipient_name?: string | null;
}

export interface NgStore {
  /** From the wallet_balances cache (never Horizon directly). */
  balances(userId: string): Promise<{ NGNT: bigint; USDC: bigint; updated_at: string | null }>;
  /** Fill the cache from Horizon (first use, or the cache is empty). */
  refreshBalances(userId: string): Promise<void>;
  /** NGNT she can spend now: cache minus outgoing money still on its way (ng_available). */
  available(userId: string): Promise<bigint>;
  hasPin(userId: string): Promise<boolean>;
  verifyPin(userId: string, pin: string): Promise<PinOutcome>;
  payees(userId: string): Promise<Payee[]>;
  /** Kobo sent out today or since sinceIso (payments, ajo, cash-outs; failed ones excluded). */
  paidSince(userId: string, sinceIso: string): Promise<bigint>;
  createAction(a: { user_id: string; kind: string; params: Record<string, unknown>; readback: string; ttl_secs: number }): Promise<Action>;
  action(id: string, userId: string): Promise<Action | null>;
  pendingActions(userId: string): Promise<Action[]>;
  /** ng_execute_pending_action: claims once; retries get { claimed: false } and the stored action. */
  execute(id: string, userId: string, extra: Record<string, unknown>): Promise<{ action: Action; claimed: boolean }>;
  rejectAction(id: string, userId: string): Promise<Action>;
  awaitingCashIns(userId: string): Promise<CashIn[]>;
  transactions(userId: string, limit: number): Promise<NgTx[]>;
  myGroup(userId: string): Promise<NgGroup | null>;
  /** Latest contribution transaction per member address in an on-chain group (contract events). */
  contributionTxs(onchainId: number): Promise<Map<string, string>>;
  /** Stellar wallets of the active registered cash agents (they may claim cash-outs). */
  agentWallets(): Promise<string[]>;
  cashOuts(userId: string): Promise<CashOut[]>;
  /** Replace the code of her own issued cash-out (resets wrong attempts). */
  setCashOutCode(userId: string, cashOutId: string, codeHash: string): Promise<boolean>;
  /** The active Plus user with this phone number, if any. */
  plusUserByPhone(phone: string): Promise<PlusPeer | null>;
  /** Kobo on its way into her wallet (pending incoming rows), for the balance limit. */
  pendingIncoming(userId: string): Promise<bigint>;
  /** Save (or rename) a payee by phone; a Plus user's wallet is saved with it. */
  savePayee(userId: string, p: { name: string; phone: string; stellar_address: string | null }): Promise<Payee>;
  /** ng_bank_transfer_in: the partner anchor sends NGNT to her wallet (+ advance repayment). Idempotent on ref. */
  bankTransferIn(userId: string, amount: bigint, repay: bigint, ref: string, sender: string): Promise<{ transaction_id: string; repay: bigint; loan?: boolean }>;
  /** Her credit picture's inputs: weeks with Plus (real + compressed demo history), assets, loans with balances, recent loan steps. */
  credit(userId: string): Promise<{
    frozen_until: string | null;
    weeks: CreditWeek[];
    assets: CreditAsset[];
    loans: CreditLoan[];
    events: { kind: string; amount: number | null; note: string | null; created_at: string }[];
  }>;
  chain: ContractReader;
}

export interface NgContext {
  user: User;
  channel: Channel;
  store: NgStore;
  args: Record<string, unknown>;
  now?: Date;
  explorer?: string;
  contractId?: string;
  /** NGNT Stellar Asset Contract (request_advance pays out of the pool in this asset). */
  ngntSac: string;
  /** HMAC key for cash-out codes (Supabase secret CASHOUT_CODE_SECRET). */
  codeSecret: string;
}

export type NgTool = (ctx: NgContext) => Promise<ToolResult>;

function refuse(text: string, error: string, extra: Record<string, unknown> = {}): ToolResult {
  return { text, ok: false, error, ...extra };
}

const CHECK_SCREEN = "Ask her to check her screen and tap Yes, or say yes.";
const PIN_ON_SCREEN = "Ask her to check her screen and type her PIN there. Never ask for the PIN out loud.";

/**
 * Money moves up to the market's PIN threshold (₦5,000) take a spoken or tapped Yes; above it, the
 * PIN, typed in the app. Accepting a loan always takes the PIN.
 */
export const NG_PIN_KINDS = ["pay", "pay_code", "group_contribution", "cash_out", "advance", "loan_repay"];
export function ngNeedsPin(a: Pick<Action, "kind" | "params">): boolean {
  if (a.kind === "loan") return true;
  if (!NG_PIN_KINDS.includes(a.kind)) return false;
  return BigInt(String(a.params.amount ?? 0)) > BigInt(getMarket(M).pinThreshold) * 100n;
}

function actionFields(a: Action) {
  return { action_id: a.id, kind: a.kind, readback: a.readback, requires_pin: ngNeedsPin(a), status: a.status, expires_at: a.expires_at };
}

function whenSpoken(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** Advance fee, as the contract computes it: amount x fee_bps / 10000 (integer). */
export function advanceFee(amount: bigint): bigint {
  return (amount * BigInt(getMarket(M).advance.feeBps)) / 10000n;
}

/** What a cash-in repays on an open advance: repayFromCashInBps of it, never more than is owed. */
export function cashInRepayment(cashIn: bigint, advance: ChainAdvance | null): bigint {
  if (!advance || advance.owed_minor <= 0n) return 0n;
  const share = (cashIn * BigInt(getMarket(M).advance.repayFromCashInBps)) / 10000n;
  return share < advance.owed_minor ? share : advance.owed_minor;
}

/** An ajo payout as the contract does it: the recipient's open advance is repaid from the pot first. */
export function payoutSplit(pot: bigint, advance: ChainAdvance | null): { repaid: bigint; net: bigint } {
  const owed = advance?.owed_minor ?? 0n;
  const repaid = owed > 0n ? (owed < pot ? owed : pot) : 0n;
  return { repaid, net: pot - repaid };
}

// ---------------------------------------------------------------------------
// Cash-out codes: 6 random digits; only an HMAC of (user, code) is stored.
// ---------------------------------------------------------------------------

export function newCashOutCode(digits = getMarket(M).cashOutCode?.digits ?? 6): string {
  const max = 10 ** digits;
  const limit = Math.floor(0x1_0000_0000 / max) * max; // rejection sampling: no modulo bias
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % max).padStart(digits, "0");
  }
}

export async function cashOutCodeHash(secret: string, userId: string, code: string): Promise<string> {
  if (!secret) throw new Error("CASHOUT_CODE_SECRET is not set");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`plus-cashout-code:v1:${userId}:${code}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

async function cachedBalances(store: NgStore, user: User) {
  let b = await store.balances(user.id);
  if (b.updated_at === null && user.stellar_pub) {
    await store.refreshBalances(user.id); // first use only; afterwards the cache is kept fresh
    b = await store.balances(user.id);
  }
  return b;
}

export const ngGetUser: NgTool = async ({ user, store }) => {
  const [cash, pending, hasPin] = await Promise.all([store.awaitingCashIns(user.id), store.pendingActions(user.id), store.hasPin(user.id)]);
  const parts = [`This is ${user.name ?? "this caller"}. Nigeria. Speak warm, short Nigerian Pidgin English unless she speaks Yoruba. Amounts in naira.`];
  if (user.kyc_tier < 1) parts.push("Her sign-up is not finished: no money can move yet.");
  for (const c of cash) parts.push(`First, waiting for her answer: ${c.helper_name} says she gave ${say(c.amount)} cash. Ask: is that right?`);
  return {
    text: parts.join(" "),
    known: true,
    user_id: user.id,
    name: user.name,
    language: user.language,
    market: M,
    currency: "NGN",
    has_pin: hasPin,
    group_savings_name: getMarket(M).groupSavings.localName,
    limits: tierSummary(user),
    virtual_account: user.virtual_account ?? null,
    bank_label: getMarket(M).virtualAccount?.bankLabel ?? null,
    cash_ins_waiting: cash.map((c) => ({ ...c, amount_text: show(c.amount) })),
    pending_actions: pending.map(actionFields),
  };
};

export const ngGetBalance: NgTool = async ({ user, store }) => {
  if (!user.stellar_pub) return { text: "Her wallet is not set up yet.", has_account: false };
  const [b, available] = await Promise.all([cachedBalances(store, user), store.available(user.id)]);
  const onTheWay = b.NGNT - available;
  const usd = b.USDC;
  const usdText = `$${usd / 100n}.${(usd % 100n).toString().padStart(2, "0")}`;
  return {
    text: `She has ${say(b.NGNT)} in her wallet` + (onTheWay > 0n ? `; ${say(onTheWay)} of it is already on its way out.` : ".") +
      (usd > 0n ? ` Also ${usdText} in dollars.` : ""),
    has_account: true,
    currency: "NGN",
    balance_minor: String(b.NGNT),
    balance_text: show(b.NGNT),
    available_minor: String(available),
    available_text: show(available),
    usd_minor: String(usd),
    usd_text: usd > 0n ? usdText : null,
    updated_at: b.updated_at,
  };
};

export const ngWhatArrived: NgTool = async ({ user, store, now = new Date(), explorer }) => {
  const [cash, txs] = await Promise.all([store.awaitingCashIns(user.id), store.transactions(user.id, 50)]);
  const since = now.getTime() - 14 * 86_400_000;
  const incoming = txs.filter((t) => (t.kind === "incoming" || t.kind === "advance" || t.kind === "loan") && new Date(t.created_at).getTime() >= since).slice(0, 5);
  const parts: string[] = [];
  // Cash waiting for her Yes or No comes first.
  for (const c of cash) {
    parts.push(`${c.helper_name} says she gave ${say(c.amount)} cash ${whenSpoken(c.created_at, now)}. It enters her wallet only after she says it is right. Ask her: is that right?`);
  }
  const from = (t: NgTx) =>
    t.kind === "advance" ? "her advance"
    : t.kind === "loan" ? "her loan from the partner lender"
    : t.source === "cash" ? `cash with ${t.counterparty ?? "the agent"}`
    : t.source === "ajo_payout" ? "her ajo payout"
    : t.source === "bank" ? `a bank transfer${t.counterparty ? ` from ${t.counterparty}` : ""}`
    : t.source === "plus_user" ? `${t.counterparty ?? "another Plus user"} on Plus`
    : "a deposit";
  if (incoming.length === 0) parts.push("Nothing else has come in for two weeks.");
  else {
    parts.push("Came in: " + incoming.map((t) => `${say(t.amount)} from ${from(t)}, ${whenSpoken(t.created_at, now)}${t.status === "pending" ? " (still on its way)" : ""}`).join("; ") + ".");
  }
  return {
    text: parts.join(" "),
    awaiting_confirmation: cash.map((c) => ({ ...c, amount_minor: String(c.amount), amount_text: show(c.amount), when: whenSpoken(c.created_at, now) })),
    arrived: incoming.map((t) => ({
      id: t.id,
      amount_minor: String(t.amount),
      amount_text: show(t.amount),
      source: t.source,
      kind: t.kind,
      from: from(t),
      status: t.status,
      at: t.created_at,
      on_stellar: t.chain_tx_hash !== null,
      url: t.chain_tx_hash && explorer ? `${explorer}/tx/${t.chain_tx_hash}` : null,
    })),
  };
};

const KIND_WORDS: Record<string, string> = {
  incoming: "came in",
  pay: "paid",
  group_contribution: "ajo",
  advance: "advance",
  repay: "advance repaid",
  loan: "loan received",
  loan_repay: "loan repayment",
  cash_out: "cash out",
  adjustment: "demo reset (testnet)",
};

export const ngMyRecord: NgTool = async ({ user, store, explorer }) => {
  const txs = await store.transactions(user.id, 500);
  let received = 0n, paid = 0n, ajo = 0n, cashedOut = 0n;
  for (const t of txs) {
    if (t.status !== "completed") continue;
    const a = BigInt(t.amount);
    if (t.kind === "incoming") received += a;
    else if (t.kind === "pay") paid += -a;
    else if (t.kind === "group_contribution") ajo += -a;
    else if (t.kind === "cash_out") cashedOut += -a;
  }
  const onChain = txs.filter((t) => t.chain_tx_hash);
  const waiting = txs.filter((t) => t.status === "pending").length;
  const cashIns = txs.filter((t) => t.kind === "incoming" && t.source === "cash" && t.status === "completed").length;
  const link = (h: string) => (explorer ? `${explorer}/tx/${h}` : null);
  return {
    text: `Her record on Stellar: ${say(received)} came in, ${say(paid)} paid, ${say(ajo)} into her ajo, ${say(cashedOut)} cashed out. ` +
      `${onChain.length} transactions, each one checkable on Stellar` + (waiting > 0 ? `, ${waiting} more on the way.` : ".") +
      " Her name is not on the chain, only her wallet address.",
    totals: {
      received_text: show(received),
      paid_text: show(paid),
      ajo_text: show(ajo),
      cashed_out_text: show(cashedOut),
    },
    cash_ins: cashIns,
    confirmed_on_stellar: onChain.length,
    waiting_for_stellar: waiting,
    recent: txs.slice(0, 40).map((t) => ({
      id: t.id,
      kind: t.kind,
      label: t.kind === "pay" && t.source === "code" ? "paid by code" : t.kind === "incoming" && t.source === "bank" ? "bank transfer" : KIND_WORDS[t.kind] ?? t.kind,
      counterparty: t.counterparty ?? null,
      source: t.source,
      amount_minor: String(t.amount),
      amount_text: show(BigInt(t.amount) < 0n ? -BigInt(t.amount) : BigInt(t.amount)),
      outgoing: BigInt(t.amount) < 0n,
      status: t.status,
      at: t.created_at,
      tx_hash: t.chain_tx_hash,
      url: t.chain_tx_hash ? link(t.chain_tx_hash) : null,
    })),
    account_url: explorer && user.stellar_pub ? `${explorer}/account/${user.stellar_pub}` : null,
  };
};

export const ngGroupStatus: NgTool = async ({ user, store, now = new Date(), explorer, contractId }) => {
  const mine = await store.myGroup(user.id);
  if (!mine) return { text: "She is not in an ajo yet.", in_group: false };
  const [g, txs, paidTx] = await Promise.all([store.chain.group(mine.onchain_id), store.transactions(user.id, 100), store.contributionTxs(mine.onchain_id)]);
  if (!g) return refuse("I can't read the ajo from Stellar just now.", "chain_unavailable");
  const names = new Map(mine.members.map((m) => [m.position, m]));
  const myIndex = mine.members.find((m) => m.user_id === user.id)?.position ?? -1;
  const onTheWay = txs.some((t) => t.kind === "group_contribution" && t.source === mine.id && t.status === "pending");
  const mineLast = txs.find((t) => t.kind === "group_contribution" && t.source === mine.id && t.chain_tx_hash);
  const members = g.members.map((_, i) => ({
    name: names.get(i)?.name ?? "Member",
    position: i,
    is_me: i === myIndex,
    paid_this_round: g.contributed[i] ?? false,
    verified_on_stellar: g.contributed[i] ?? false, // read from the contract itself
    is_turn: i === g.turn,
    // Each tick links to that member's own contribution on Stellar (contract event), hers to her transaction.
    url: !explorer || !g.contributed[i] ? null
      : i === myIndex && mineLast?.chain_tx_hash ? `${explorer}/tx/${mineLast.chain_tx_hash}`
      : paidTx.get(g.members[i]) ? `${explorer}/tx/${paidTx.get(g.members[i])}` : null,
  }));
  const paidCount = g.contributed.filter(Boolean).length;
  const turnName = members[g.turn]?.is_me ? "her" : members[g.turn]?.name ?? "the next member";
  const iPaid = myIndex >= 0 && g.contributed[myIndex];
  const hoursLeft = Math.max(0, Math.round((g.next_due.getTime() - now.getTime()) / 3_600_000));
  return {
    text: `${mine.name}: ${paidCount} of ${members.length} have paid ${say(g.amount_minor)} this round. ` +
      (iPaid ? "Her part is paid." : onTheWay ? "Her part is on its way." : "Her part is not paid yet.") +
      ` This round's pot of ${say(g.amount_minor * BigInt(members.length))} goes to ${turnName}` +
      (hoursLeft > 0 ? `, in about ${hoursLeft} hours.` : ", now."),
    in_group: true,
    group_id: mine.id,
    onchain_id: mine.onchain_id,
    name: mine.name,
    local_name: "ajo",
    amount_minor: String(g.amount_minor),
    amount_text: show(g.amount_minor),
    pot_text: show(g.pot_minor),
    period_days: Math.round(g.period_secs / 86_400),
    next_due: g.next_due.toISOString(),
    turn: g.turn,
    turn_name: members[g.turn]?.name ?? null,
    paid_this_period: Boolean(iPaid),
    on_its_way: onTheWay,
    members,
    contract_url: explorer && contractId ? `${explorer}/contract/${contractId}` : null,
  };
};

export const ngAdvanceStatus: NgTool = async ({ user, store }) => {
  if (!user.stellar_pub) return refuse("Her wallet is not set up yet.", "no_wallet");
  const rules = getMarket(M).advance;
  const [limitRaw, open] = await Promise.all([store.chain.limitOf(user.stellar_pub), store.chain.advanceOf(user.stellar_pub)]);
  const maxMinor = BigInt(rules.max) * 100n;
  const minMinor = BigInt(rules.min) * 100n;
  const limit = limitRaw > maxMinor ? maxMinor : limitRaw;
  const blocked = advanceAllowed(user);
  const eligible = limit >= minMinor && !open && !blocked;
  const options = [];
  for (let a = minMinor; a <= limit; a += 500000n) options.push({ amount_minor: String(a), amount_text: show(a), fee_text: show(advanceFee(a)) });
  if (limit >= minMinor && options.at(-1)?.amount_minor !== String(limit)) {
    options.push({ amount_minor: String(limit), amount_text: show(limit), fee_text: show(advanceFee(limit)) });
  }
  const repayPct = rules.repayFromCashInBps / 100;
  const text = open
    ? `She has an advance: ${say(open.owed_minor)} left to repay. ${repayPct}% of each cash-in pays it back by itself.`
    : eligible
    ? `She can take an advance of up to ${say(limit)}. The fee is ${rules.feeBps / 100}%, one time: ${say(advanceFee(limit))} on ${say(limit)}. No interest, no late fees.`
    : blocked ? blocked.text
    : "She can't take an advance yet.";
  return {
    text,
    eligible,
    open: Boolean(open),
    limit_minor: String(limit),
    limit_text: show(limit),
    fee_bps: rules.feeBps,
    repay_pct: repayPct,
    blocked: blocked?.error ?? null,
    owed_minor: String(open?.owed_minor ?? 0n),
    owed_text: show(open?.owed_minor ?? 0n),
    principal_text: open ? show(open.principal_minor) : null,
    fee_text: open ? show(open.fee_minor) : null,
    repaid_text: open ? show(open.principal_minor + open.fee_minor - open.owed_minor) : null,
    options,
  };
};

export const ngCashOuts: NgTool = async ({ user, store, now = new Date() }) => {
  const list = await store.cashOuts(user.id);
  const open = list.filter((c) => c.status === "issued" && new Date(c.expires_at) > now);
  return {
    text: open.length === 0 ? "No cash-out is waiting." : `${open.length} cash-out${open.length > 1 ? "s" : ""} waiting for an agent: ${open.map((c) => say(c.amount)).join(", ")}.`,
    cash_outs: list.slice(0, 10).map((c) => ({ ...c, amount_text: show(c.amount) })),
  };
};

// ---------------------------------------------------------------------------
// Prepare tools (money moves only after confirm_action)
// ---------------------------------------------------------------------------

async function spendCheck(store: NgStore, user: User, amount: bigint, now: Date): Promise<ToolResult | null> {
  if (user.kyc_tier < 1) return refuse("Her account is not open yet. Finish signing up first.", "signup_not_finished");
  const [available, paidToday] = await Promise.all([store.available(user.id), store.paidSince(user.id, dayStart(M, now))]);
  // The tier limit first: more money in the wallet would not fix that one.
  const limit = spendAllowed(user, amount, paidToday);
  if (limit) return limit;
  if (available < amount) {
    return refuse(`Not enough money: she has ${say(available > 0n ? available : 0n)} to spend.`, "insufficient_funds", { available_text: show(available) });
  }
  return null;
}

/** Room in a wallet for incoming money: its balance limit minus what it holds and what is on its way. */
async function receiveCheck(store: NgStore, who: { id: string; market_id: "in" | "ng"; kyc_tier: number }, amount: bigint, whose = "her"): Promise<ToolResult | null> {
  const [b, incoming] = await Promise.all([store.balances(who.id), store.pendingIncoming(who.id)]);
  return receiveAllowed(who, b.NGNT + incoming, amount, whose);
}

function confirmText(a: Action): string {
  return ngNeedsPin(a) ? PIN_ON_SCREEN : CHECK_SCREEN;
}

/**
 * Pay someone: a saved payee by name, or anyone by phone number.
 *   A Plus user (her wallet)   -> an NGNT payment wallet to wallet; it shows in what arrived for them.
 *   Not on Plus                -> a code they collect as cash at any Plus agent (claimable balance on
 *                                 Stellar; the SMS with the code is simulated on her screen).
 *   A saved wallet (Iya Tunde) -> a payment to that wallet.
 */
export const ngPreparePay: NgTool = async ({ user, store, args, now = new Date() }) => {
  const amount = parseMajorAmount(args.amount);
  if (amount === null) return refuse("How much should she pay? Ask for the amount in naira.", "invalid_amount");
  const spoken = typeof args.payee === "string" ? args.payee.trim() : "";
  const given = typeof args.phone === "string" && args.phone.trim() ? args.phone : /^[+\d][\d\s()-]{6,}$/.test(spoken) ? spoken : "";
  let phone: string | null = null;
  let name = typeof args.name === "string" && args.name.trim() ? args.name.trim().slice(0, 60) : null;
  let wallet: string | null = null;
  let payeeId: string | null = null;

  if (given) {
    phone = normalizePhone(M, given);
    if (!phone) return refuse("That phone number doesn't look right. Ask her to say it again, digit by digit.", "invalid_phone");
  } else {
    const payees = await store.payees(user.id);
    if (payees.length === 0) return refuse("She has no saved payees yet. Ask for the person's phone number.", "no_payees");
    const match = matchPayee(spoken, payees);
    if (match.kind !== "match") {
      const names = match.options.map((p) => p.name);
      return refuse(
        match.kind === "ambiguous"
          ? `Which one: ${names.join(" or ")}? Ask her; don't guess.`
          : `"${spoken}" is not one of her saved payees: ${names.join(", ")}. Ask which one she means, or for their phone number.`,
        match.kind === "ambiguous" ? "ambiguous_payee" : "unknown_payee",
        { options: match.options.map((p) => ({ id: p.id, name: p.name })) },
      );
    }
    payeeId = match.payee.id;
    name = match.payee.name;
    phone = match.payee.phone ?? null;
    wallet = phone ? null : match.payee.stellar_address ?? null;
    if (!phone && !wallet) return refuse(`${match.payee.name} has no phone or wallet saved.`, "payee_incomplete");
  }

  const peer = phone ? await store.plusUserByPhone(phone) : null;
  if (peer && peer.id === user.id) return refuse("That is her own number.", "own_number");
  const blocked = await spendCheck(store, user, amount, now);
  if (blocked) return blocked;

  // Another Plus user in Nigeria with a wallet: wallet to wallet, inside their balance limit.
  if (peer && peer.market_id === "ng" && peer.stellar_pub) {
    const full = await receiveCheck(store, peer, amount, `${peer.name ?? "their"}'s`);
    if (full) return refuse(`${peer.name ?? "That person"}'s wallet can't take that much now. ${full.text}`, "recipient_full", { room_text: full.room_text });
    const who = name ?? peer.name ?? phone!;
    const a = await store.createAction({
      user_id: user.id,
      kind: "pay",
      params: { amount: String(amount), to: peer.stellar_pub, to_user_id: peer.id, payee_name: who, phone, payee_id: payeeId },
      readback: `${show(amount)} to ${who} (on Plus)`,
      ttl_secs: ACTION_TTL_SECS,
    });
    return {
      text: `Read back: ${say(amount)} to ${who}. ${who} is on Plus, so it goes straight to their wallet. ${confirmText(a)}`,
      ok: true,
      ...actionFields(a),
      payee: { name: who, phone, on_plus: true },
      amount_text: show(amount),
    };
  }

  // Not on Plus: a code they collect at any Plus agent.
  if (phone) {
    const agents = await store.agentWallets();
    if (agents.length === 0) return refuse("No cash agent is registered yet, so a code can't be collected.", "no_agents");
    const who = name ?? phone;
    const days = getMarket(M).cashOutCode?.returnAfterDays ?? 7;
    const a = await store.createAction({
      user_id: user.id,
      kind: "pay_code",
      params: { amount: String(amount), phone, payee_name: who, claimants: agents.slice(0, 9), payee_id: payeeId },
      readback: `${show(amount)} to ${who} (${phone}). Not on Plus: they get a code by SMS and collect cash at any Plus agent. Unused after ${days} days, it comes back to you.`,
      ttl_secs: ACTION_TTL_SECS,
    });
    return {
      text: `Read back: ${say(amount)} to ${who}. They are not on Plus yet, so they get a code by text message and collect the cash at any Plus agent. ${confirmText(a)}`,
      ok: true,
      ...actionFields(a),
      payee: { name: who, phone, on_plus: false },
      amount_text: show(amount),
    };
  }

  // A saved wallet (no phone): a plain payment.
  const a = await store.createAction({
    user_id: user.id,
    kind: "pay",
    params: { amount: String(amount), payee_id: payeeId, payee_name: name, to: wallet },
    readback: `${show(amount)} to ${name}`,
    ttl_secs: ACTION_TTL_SECS,
  });
  return {
    text: `Read back: ${say(amount)} to ${name}. ${confirmText(a)}`,
    ok: true,
    ...actionFields(a),
    payee: { id: payeeId, name },
    amount_text: show(amount),
  };
};

/** After a payment: keep this person for next time (by phone; a Plus user's wallet goes with it). */
export const ngSavePayee: NgTool = async ({ user, store, args }) => {
  const phone = normalizePhone(M, args.phone);
  const name = typeof args.name === "string" ? args.name.trim().replace(/\s+/g, " ").slice(0, 60) : "";
  if (!phone) return refuse("Which phone number? Ask again.", "invalid_phone");
  if (name.length < 2) return refuse("What name should we save them under?", "invalid_name");
  const peer = await store.plusUserByPhone(phone);
  if (peer?.id === user.id) return refuse("That is her own number.", "own_number");
  const p = await store.savePayee(user.id, { name, phone, stellar_address: peer?.market_id === "ng" ? peer.stellar_pub : null });
  return { text: `Saved ${p.name}. Next time she can just say "pay ${p.name}".`, ok: true, payee: { id: p.id, name: p.name, phone } };
};

/** Her account number at the partner bank (simulated), for bank transfers into her wallet. */
export const ngBankDetails: NgTool = async ({ user }) => {
  const bank = getMarket(M).virtualAccount;
  if (!bank || !user.virtual_account) return refuse("Her bank account number comes with her wallet; her wallet is not open yet.", "no_account_number");
  const spaced = user.virtual_account.replace(/(\d{3})(\d{3})(\d{4})/, "$1 $2 $3");
  return {
    text: `Anyone can send her money by bank transfer: ${bank.bankLabel}, account number ${user.virtual_account.split("").join(" ")}, name ${user.name}. It lands in her Plus wallet on Stellar.`,
    ok: true,
    bank_label: bank.bankLabel,
    account_number: user.virtual_account,
    account_number_text: spaced,
    account_name: user.name,
  };
};

/**
 * Demo (app only): a transfer arrives at her virtual account. The partner's anchor account sends the
 * same NGNT to her wallet on Stellar; 10% repays an open loan (or a legacy advance) right after it lands.
 */
export const ngSimulateBankTransfer: NgTool = async ({ user, store, args, channel }) => {
  if (channel !== "app") return refuse("Only the demo button on her screen can do that.", "app_only");
  if (!user.stellar_pub || !user.virtual_account) return refuse("Her wallet is not open yet.", "no_wallet");
  const amount = parseMajorAmount(args.amount);
  if (amount === null) return refuse("Enter an amount in naira.", "invalid_amount");
  const full = await receiveCheck(store, user, amount);
  if (full) return full;
  const ref = typeof args.ref === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(args.ref) ? args.ref : crypto.randomUUID();
  const sender = typeof args.sender === "string" && args.sender.trim() ? args.sender.trim().slice(0, 60) : "A bank customer";
  const repay = cashInRepayment(amount, await store.chain.advanceOf(user.stellar_pub));
  const r = await store.bankTransferIn(user.id, amount, repay, ref, sender);
  return {
    text: `${say(amount)} arrived by bank transfer from ${sender}. It is on its way into her wallet on Stellar.` +
      (r.repay > 0n ? ` ${say(r.repay)} of it pays back her advance.` : "") +
      (r.loan ? " 10 percent of it goes to her loan." : ""),
    ok: true,
    sending: true,
    transaction_id: r.transaction_id,
    amount_text: show(amount),
    repay_text: r.repay > 0n ? show(r.repay) : null,
  };
};

export const ngPrepareAjo: NgTool = async ({ user, store, now = new Date() }) => {
  const mine = await store.myGroup(user.id);
  if (!mine) return refuse("She is not in an ajo.", "no_group");
  const myIndex = mine.members.find((m) => m.user_id === user.id)?.position ?? -1;
  const [g, txs] = await Promise.all([store.chain.group(mine.onchain_id), store.transactions(user.id, 50)]);
  if (!g || myIndex < 0) return refuse("I can't read the ajo from Stellar just now.", "chain_unavailable");
  if (g.contributed[myIndex]) return refuse(`Her ${mine.name} contribution is already paid this round.`, "already_paid");
  if (txs.some((t) => t.kind === "group_contribution" && t.source === mine.id && t.status === "pending")) {
    return refuse("Her ajo payment is already on its way.", "already_sending");
  }
  const amount = g.amount_minor;
  const blocked = await spendCheck(store, user, amount, now);
  if (blocked) return blocked;
  const a = await store.createAction({
    user_id: user.id,
    kind: "group_contribution",
    params: { amount: String(amount), group_id: mine.id, group_name: mine.name, onchain_id: mine.onchain_id },
    readback: `${show(amount)} to ${mine.name}`,
    ttl_secs: ACTION_TTL_SECS,
  });
  return { text: `Read back: ${say(amount)} for ${mine.name}, this round. ${confirmText(a)}`, ok: true, ...actionFields(a), amount_text: show(amount) };
};

export const ngPrepareAdvance: NgTool = async ({ user, store, args, ngntSac }) => {
  if (!user.stellar_pub) return refuse("Her wallet is not set up yet.", "no_wallet");
  const rules = getMarket(M).advance;
  const amount = parseMajorAmount(args.amount);
  if (amount === null) return refuse("How much advance? Ask for the amount in naira.", "invalid_amount");
  if (amount % 100n !== 0n) return refuse("Advances are in whole naira.", "invalid_amount");
  const [limitRaw, open, pool] = await Promise.all([
    store.chain.limitOf(user.stellar_pub),
    store.chain.advanceOf(user.stellar_pub),
    store.chain.poolBalance(ngntSac),
  ]);
  const gate = advanceAllowed(user);
  if (gate) return gate;
  if (open) return refuse(`She already has an advance open: ${say(open.owed_minor)} left to repay. One at a time.`, "advance_open", { owed_text: show(open.owed_minor) });
  const maxMinor = BigInt(rules.max) * 100n;
  const limit = limitRaw > maxMinor ? maxMinor : limitRaw;
  if (amount < BigInt(rules.min) * 100n) return refuse(`The smallest advance is ${say(BigInt(rules.min) * 100n)}.`, "below_min");
  if (amount > limit) return refuse(`That is over her limit. She can take up to ${say(limit)}.`, "over_limit", { limit_text: show(limit) });
  if (pool < amount) return refuse("Advances are paused just now. Try again later.", "pool_low");
  const fee = advanceFee(amount);
  const pct = rules.repayFromCashInBps / 100;
  const a = await store.createAction({
    user_id: user.id,
    kind: "advance",
    params: { amount: String(amount), fee: String(fee), asset_sac: ngntSac },
    readback: `Advance ${show(amount)}. Fee ${show(fee)}, one time. No interest, no late fees. Repaid with ${pct}% of each cash-in.`,
    ttl_secs: ACTION_TTL_SECS,
  });
  return {
    text: `Read back: an advance of ${say(amount)}. The fee is ${say(fee)}, one time. No interest and no late fees. ` +
      `It pays itself back with ${pct} percent of every cash-in. ${confirmText(a)}`,
    ok: true,
    ...actionFields(a),
    amount_text: show(amount),
    fee_text: show(fee),
    total_text: show(amount + fee),
  };
};

export const ngPrepareCashout: NgTool = async ({ user, store, args, now = new Date() }) => {
  const rules = getMarket(M).cashOutCode;
  if (!rules || !user.stellar_pub) return refuse("Cash-out is not available.", "not_available");
  const amount = parseMajorAmount(args.amount);
  if (amount === null) return refuse("How much cash does she want? Ask for the amount in naira.", "invalid_amount");
  const agents = await store.agentWallets();
  if (agents.length === 0) return refuse("No cash agent is registered yet.", "no_agents");
  const blocked = await spendCheck(store, user, amount, now);
  if (blocked) return blocked;
  const a = await store.createAction({
    user_id: user.id,
    kind: "cash_out",
    params: { amount: String(amount), claimants: agents.slice(0, 9) }, // a claimable balance takes up to 10 claimants (her own is the 10th)
    readback: `Cash out ${show(amount)}. You get a code to show the agent. Unused after ${rules.returnAfterDays} days, it comes back to you.`,
    ttl_secs: ACTION_TTL_SECS,
  });
  return {
    text: `Read back: cash out ${say(amount)}. She gets a code on her screen to show the agent. ${confirmText(a)}`,
    ok: true,
    ...actionFields(a),
    amount_text: show(amount),
  };
};

// ---------------------------------------------------------------------------
// Confirm / reject
// ---------------------------------------------------------------------------

function doneText(a: Action): string {
  const r = a.result ?? {};
  const amt = say(String(r.amount ?? a.params.amount));
  const tail = " Sending on Stellar now; the tick shows on her screen in a few seconds.";
  switch (a.kind) {
    case "pay":
      return `Okay: ${amt} to ${String(r.payee_name ?? a.params.payee_name)}.${tail}`;
    case "pay_code":
      return `Okay: ${amt} for ${String(r.payee_name ?? a.params.payee_name)}. They get a text message with a code and collect the cash at any Plus agent.${tail}`;
    case "group_contribution":
      return `Okay: ${amt} for her ajo.${tail}`;
    case "advance":
      return `Okay: advance of ${amt}.${tail}`;
    case "cash_out":
      return `Okay: cash-out of ${amt}. Her code is on her screen; she shows it to the agent, and the agent gives her the cash.${tail}`;
    case "confirm_cash_in": {
      const repay = BigInt(String(r.repay ?? 0));
      const loan = BigInt(String(r.loan_repay ?? 0));
      return `Okay: ${amt} cash from ${String(r.helper_name ?? a.params.helper_name)} is going into her wallet.` +
        (repay > 0n ? ` ${say(repay)} of it pays back her advance.` : "") +
        (loan > 0n ? ` ${say(loan)} of it, 10 percent, goes to her loan.` : "") + tail;
    }
    case "loan":
      return `Okay: her loan of ${amt} is on its way from the partner lender.${tail}`;
    case "loan_repay":
      return `Okay: ${amt} to her loan.${tail}`;
    case "loan_extension":
      return `Done: her next payment is now due ${spokenDate(String(r.next_due_at ?? a.params.new_due_at))}. New borrowing is paused until this loan is repaid.`;
    case "loan_restructure":
      return `Done: smaller payments now, ${say(String(r.minimum ?? a.params.minimum))} every two weeks.`;
  }
  return "Okay." + tail;
}

function statusText(a: Action): string {
  switch (a.status) {
    case "done":
      return doneText(a);
    case "failed":
      return a.result?.error === "insufficient_funds" ? "It didn't go through: not enough money. Nothing left her wallet." : "It didn't go through. Nothing left her wallet.";
    case "rejected":
      return a.kind === "confirm_cash_in" ? "Okay, that cash is marked as not received." : "Okay, cancelled. Nothing was sent.";
    case "expired":
      return "That request has expired. Nothing happened; start again if she still wants it.";
    default:
      return "It is still being processed.";
  }
}

export const ngConfirmAction: NgTool = async ({ user, store, args, channel, codeSecret }) => {
  const id = typeof args.action_id === "string" ? args.action_id : "";
  const pin = typeof args.pin === "string" ? args.pin : undefined;
  if (channel === "voice" && pin !== undefined) return refuse("Never take the PIN by voice. Ask her to type it on her screen.", "pin_not_allowed_by_voice");
  const a = id ? await store.action(id, user.id) : null;
  if (!a) return refuse("I couldn't find that request. Start again.", "not_found");

  const extra: Record<string, unknown> = {};
  let code: string | null = null;
  if (a.status === "pending") {
    if (ngNeedsPin(a)) {
      if (channel === "voice") {
        return { text: "This amount needs her PIN. Ask her to type it on the screen; you can't confirm it by voice.", ok: false, error: "pin_required_on_screen", ...actionFields(a) };
      }
      if (pin === undefined) return refuse("Type your PIN to confirm.", "pin_required", actionFields(a));
      const check = await store.verifyPin(user.id, pin);
      if (!check.ok) {
        if (check.outcome === "not_set") return refuse("Set a PIN in Settings first.", "pin_not_set");
        if (check.outcome === "locked") return refuse("Too many wrong PINs. Try again in 15 minutes.", "pin_locked", { locked_until: check.lockedUntil });
        return refuse(`Wrong PIN. ${check.attemptsLeft} ${check.attemptsLeft === 1 ? "try" : "tries"} left.`, "pin_wrong", { attempts_left: check.attemptsLeft });
      }
    }
    if (a.kind === "cash_out" || a.kind === "pay_code") {
      code = newCashOutCode();
      extra.code_hash = await cashOutCodeHash(codeSecret, user.id, code);
    }
    if (a.kind === "confirm_cash_in" && user.stellar_pub) {
      extra.repay = String(cashInRepayment(BigInt(String(a.params.amount)), await store.chain.advanceOf(user.stellar_pub)));
    }
  }
  // Claims once; a retry (or a second device) gets the stored result and queues nothing new.
  const { action: done, claimed } = await store.execute(a.id, user.id, extra);
  const ok = done.status === "done";
  return {
    text: statusText(done),
    ok,
    action_id: done.id,
    kind: done.kind,
    status: done.status,
    sending: ok,
    result: done.result,
    transaction_id: done.result?.transaction_id ?? null,
    // The code is shown once, on the screen only (never handed to the voice agent).
    cash_out_code: ok && claimed && code && channel === "app" && done.kind === "cash_out" ? code : undefined,
    // Paying someone not on Plus: the SMS they would get, simulated on her screen (never to voice).
    pay_code_sms: ok && claimed && code && channel === "app" && done.kind === "pay_code"
      ? {
        to: String(done.params.phone),
        code,
        text: `Plus: ${user.name ?? "Someone"} sent you ${show(String(done.params.amount))}. Collect it as cash at any Plus agent with code ${code} and this phone number. It works for ${getMarket(M).cashOutCode?.returnAfterDays ?? 7} days.`,
      }
      : undefined,
    cash_out_id: done.result?.cash_out_id ?? undefined,
  };
};

export const ngRejectAction: NgTool = async ({ user, store, args }) => {
  const id = typeof args.action_id === "string" ? args.action_id : "";
  const a = id ? await store.action(id, user.id) : null;
  if (!a) return refuse("I couldn't find that request.", "not_found");
  const done = await store.rejectAction(a.id, user.id);
  return { text: statusText(done), ok: done.status === "rejected", action_id: done.id, kind: done.kind, status: done.status };
};

/** App only: a fresh code for one of her waiting cash-outs (the old code stops working). */
export const ngNewCashOutCode: NgTool = async ({ user, store, args, channel, codeSecret, now = new Date() }) => {
  if (channel !== "app") return refuse("The code is only shown on her screen.", "app_only");
  const id = typeof args.cash_out_id === "string" ? args.cash_out_id : "";
  const c = (await store.cashOuts(user.id)).find((x) => x.id === id);
  if (!c || c.status !== "issued" || new Date(c.expires_at) <= now) return refuse("That cash-out is not waiting any more.", "not_redeemable");
  const code = newCashOutCode();
  if (!(await store.setCashOutCode(user.id, c.id, await cashOutCodeHash(codeSecret, user.id, code)))) return refuse("That cash-out is not waiting any more.", "not_redeemable");
  return { text: "New code ready on her screen.", ok: true, cash_out_id: c.id, cash_out_code: code, amount_text: show(c.amount), expires_at: c.expires_at };
};

// ---------------------------------------------------------------------------
// Loans (piece 4): progress before unlock, the offer and why, the ladder, repay, more time
// ---------------------------------------------------------------------------

const LENDER = () => lendingRules().lenderLabel;

export function spokenDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-NG", { weekday: "long", day: "numeric", month: "long", timeZone: "Africa/Lagos" });
}

async function picture(store: NgStore, user: User, now: Date) {
  const c = await store.credit(user.id);
  const p = creditPicture({ member_since: user.member_since ?? new Date().toISOString(), kyc_tier: user.kyc_tier, frozen_until: c.frozen_until, weeks: c.weeks, assets: c.assets, loans: c.loans, now });
  return { c, p };
}

function loanView(l: CreditLoan, now: Date) {
  const due = new Date(l.next_due_at);
  const periodLeft = l.minimum - l.period_paid > 0n ? l.minimum - l.period_paid : 0n;
  const owed = l.outstanding;
  return {
    id: l.id,
    status: l.status,
    principal_text: show(l.principal),
    cost_text: show(l.cost),
    total_text: show(l.total),
    repaid_text: show(l.repaid),
    in_flight_text: l.in_flight > 0n ? show(l.in_flight) : null,
    outstanding_minor: String(owed),
    outstanding_text: show(owed),
    progress: l.total > 0n ? Number(((l.repaid + l.in_flight) * 100n) / l.total) : 0,
    minimum_text: show(l.minimum),
    due_now_minor: String(periodLeft < owed ? periodLeft : owed),
    due_now_text: show(periodLeft < owed ? periodLeft : owed),
    next_due_at: l.next_due_at,
    next_due_text: spokenDate(l.next_due_at),
    overdue: due <= now && periodLeft > 0n,
    grace_until: l.grace_until,
    repay_pct: l.repay_bps / 100,
    can_extend: !l.extended_once,
    can_restructure: !l.restructured_once && (l.status === "late" || l.missed > 0 || l.grace_until !== null),
    borrowing_paused: l.borrowing_paused,
    disbursed: l.disbursed,
  };
}

/** Her loan picture: progress before unlock, the offer (and why) once unlocked, or the loan she is repaying. */
export const ngLoanStatus: NgTool = async ({ user, store, now = new Date() }) => {
  if (!getMarket(M).lending) return refuse("Loans are not offered here yet.", "not_available");
  const { c, p } = await picture(store, user, now);
  const L = lendingRules();
  const repayLine = `${L.repay.fromMoneyInBps / 100}% of every money-in, and at least ${say(BigInt(L.repay.minimum) * 100n)} every two weeks`;
  const ladder = p.ladder.map((s) => ({ ...s, max: String(s.max), max_text: show(s.max), cost_pct: s.cost_bps / 100, collateral_text: collateralWords(s.collateral_pct) }));
  const why = p.why;
  const base = {
    ok: true,
    week: p.week,
    weeks_needed: p.weeks_needed,
    weeks_left: p.weeks_left,
    checklist: p.checklist,
    unlocked: p.unlocked,
    ladder,
    why,
    score: p.score,
    lender: L.lenderLabel,
    events: c.events.slice(0, 5).map((e) => ({ ...e, amount_text: e.amount !== null ? show(e.amount) : null })),
  };
  if (p.open) {
    const v = loanView(p.open, now);
    const text = `Her loan: ${say(p.open.outstanding)} left of ${say(p.open.total)}. ` +
      (v.overdue ? `${say(BigInt(v.due_now_minor))} is due now${p.open.grace_until ? `; she has until ${spokenDate(p.open.grace_until)}` : ""}. `
        : `Next: at least ${say(BigInt(v.due_now_minor))} by ${v.next_due_text}. `) +
      `${p.open.repay_bps / 100}% of every money-in pays it by itself.` +
      (p.open.status === "late" ? " A payment is late: she can ask for smaller payments (restructure). Nobody else is ever contacted." : "") +
      (p.open.borrowing_paused ? " New borrowing is paused until it is repaid." : "");
    return { ...base, text, view: "repay", loan: v };
  }
  if (p.blocked === "frozen") {
    return { ...base, text: "New borrowing is frozen after missed payments. Her record keeps building; it opens again once things are back on track.", view: "paused" };
  }
  if (!p.unlocked) {
    const todo = p.checklist.filter((x) => !x.done).map((x) => `${x.label.toLowerCase()} (${x.detail})`);
    return {
      ...base,
      view: "building",
      text: `She is building her Plus history: week ${p.week} of ${p.weeks_needed}. Still to come: ${todo.join("; ")}. ` +
        `An estimate, not an offer: about ${say(p.estimate.low)} to ${say(p.estimate.high)} once it opens. Never say rejected or not eligible.`,
      estimate: { low_text: show(p.estimate.low), high_text: show(p.estimate.high) },
    };
  }
  const o = p.offer!;
  const a = p.affordability;
  return {
    ...base,
    view: "offer",
    text: `She has a loan offer from the partner lender: she receives ${say(o.amount)}, the cost is ${say(o.cost)}, total ${say(o.total)}. ` +
      `Why: activity ${why[0].weight}%, verified assets ${why[1].weight}%, savings consistency ${why[2].weight}%. ` +
      `Repay ${repayLine}. After she repays, the next loan can be ${ladder[Math.min(p.step + 1, ladder.length - 1)].max_text} at ${ladder[Math.min(p.step + 1, ladder.length - 1)].cost_pct}%. ` +
      `Accepting needs her PIN on the screen.`,
    offer: {
      amount_minor: String(o.amount), amount_text: show(o.amount), cost_text: show(o.cost), total_text: show(o.total),
      cost_pct: o.cost_bps / 100, collateral_pct: o.collateral_pct, approval: o.approval, repay_text: repayLine,
      minimum_text: show(BigInt(L.repay.minimum) * 100n), repay_pct: L.repay.fromMoneyInBps / 100,
    },
    affordability: {
      asset: p.collateral_asset ? `${p.collateral_asset.description} (${levelWords(p.collateral_asset.level)})` : null,
      estimated_value_text: show(a.estimated_value), lending_value_text: show(a.lending_value), affordable_text: show(a.affordable),
      collateral_needed_text: show((o.amount * BigInt(o.collateral_pct)) / 100n), limited_by: a.limited_by,
    },
  };
};

/** Accept the offer (or less): always confirmed with her PIN on the screen. */
export const ngPrepareLoan: NgTool = async ({ user, store, args, now = new Date() }) => {
  if (!user.stellar_pub) return refuse("Her wallet is not set up yet.", "no_wallet");
  const { p } = await picture(store, user, now);
  if (p.open) return refuse(`She already has a loan: ${say(p.open.outstanding)} left. One at a time.`, "loan_open");
  if (p.blocked === "frozen") return refuse("New borrowing is frozen after missed payments.", "borrowing_frozen");
  if (!p.unlocked || !p.offer) {
    return refuse(`Her history is still building: week ${p.week} of ${p.weeks_needed}. Tell her what is left; never say rejected or not eligible.`, "still_building");
  }
  const L = lendingRules();
  const asked = args.amount === undefined || args.amount === null || args.amount === "" ? p.offer.amount : parseMajorAmount(args.amount);
  if (asked === null) return refuse("How much? Ask for the amount in naira.", "invalid_amount");
  if (asked > p.offer.amount) return refuse(`Her offer is up to ${say(p.offer.amount)}.`, "over_offer", { offer_text: show(p.offer.amount) });
  if (asked < 1000n * 100n) return refuse("The smallest loan is 1,000 naira.", "below_min");
  const step = L.ladder[p.step];
  const cost = (asked * BigInt(step.costBps)) / 10000n;
  const a = await store.createAction({
    user_id: user.id,
    kind: "loan",
    params: {
      amount: String(asked), cost: String(cost), total: String(asked + cost), step: p.step,
      repay_bps: L.repay.fromMoneyInBps, minimum: String(BigInt(L.repay.minimum) * 100n), every_days: L.repay.everyDays,
      collateral_asset_id: p.collateral_asset?.id ?? null, collateral_pct: step.collateralPct,
    },
    readback: `Loan from the partner lender: you receive ${show(asked)}, cost ${show(cost)}, total ${show(asked + cost)}. ` +
      `Repay ${L.repay.fromMoneyInBps / 100}% of every money-in, at least ${show(BigInt(L.repay.minimum) * 100n)} every two weeks.`,
    ttl_secs: ACTION_TTL_SECS,
  });
  return {
    text: `Read back: she receives ${say(asked)}, the cost is ${say(cost)}, total ${say(asked + cost)}. ` +
      `She repays ${L.repay.fromMoneyInBps / 100} percent of every money-in, and at least ${say(BigInt(L.repay.minimum) * 100n)} every two weeks. ${PIN_ON_SCREEN}`,
    ok: true,
    ...actionFields(a),
    amount_text: show(asked),
    cost_text: show(cost),
    total_text: show(asked + cost),
  };
};

/** "Repay now": any amount up to what she owes, from her wallet. */
export const ngPrepareLoanRepay: NgTool = async ({ user, store, args, now = new Date() }) => {
  const { p } = await picture(store, user, now);
  if (!p.open) return refuse("She has no loan to repay.", "no_loan_open");
  const owed = p.open.outstanding;
  const asked = args.amount === undefined || args.amount === null || args.amount === "" ? owed : parseMajorAmount(args.amount);
  if (asked === null) return refuse("How much should she repay? Ask for the amount in naira.", "invalid_amount");
  const amount = asked > owed ? owed : asked;
  if (amount <= 0n) return refuse("Nothing is owed on her loan.", "nothing_owed");
  const available = await store.available(user.id);
  if (available < amount) return refuse(`Not enough money: she has ${say(available > 0n ? available : 0n)} to spend.`, "insufficient_funds", { available_text: show(available) });
  const a = await store.createAction({
    user_id: user.id,
    kind: "loan_repay",
    params: { amount: String(amount), loan_id: p.open.id },
    readback: `${show(amount)} to your loan. ${amount === owed ? "That repays it in full." : `${show(owed - amount)} left after this.`}`,
    ttl_secs: ACTION_TTL_SECS,
  });
  return { text: `Read back: ${say(amount)} to her loan. ${confirmText(a)}`, ok: true, ...actionFields(a), amount_text: show(amount) };
};

/** "I need more time": the next payment moves (once per loan); new borrowing pauses until repaid. */
export const ngLoanMoreTime: NgTool = async ({ user, store, now = new Date() }) => {
  const { p } = await picture(store, user, now);
  if (!p.open) return refuse("She has no loan.", "no_loan_open");
  if (p.open.extended_once) {
    return p.open.restructured_once
      ? refuse("This loan already had more time and smaller payments. Her payments come from 10% of what comes in.", "not_available")
      : refuse("This loan already had more time once. She can ask for smaller payments instead (restructure).", "already_extended", { can_restructure: true });
  }
  const days = lendingRules().extensionDays;
  const newDue = new Date(new Date(p.open.next_due_at).getTime() + days * 86_400_000).toISOString();
  const a = await store.createAction({
    user_id: user.id,
    kind: "loan_extension",
    params: { loan_id: p.open.id, days, new_due_at: newDue },
    readback: `More time: your next payment moves from ${spokenDate(p.open.next_due_at)} to ${spokenDate(newDue)}. New borrowing pauses until this loan is repaid. No extra cost.`,
    ttl_secs: ACTION_TTL_SECS,
  });
  return {
    text: `She can have ${days} more days: the next payment moves to ${spokenDate(newDue)}, at no extra cost, and new borrowing pauses until the loan is repaid. ${CHECK_SCREEN}`,
    ok: true, ...actionFields(a),
  };
};

/** After a missed payment: smaller payments over a longer time (once per loan). */
export const ngLoanRestructure: NgTool = async ({ user, store, now = new Date() }) => {
  const { p } = await picture(store, user, now);
  if (!p.open) return refuse("She has no loan.", "no_loan_open");
  if (p.open.restructured_once) return refuse("This loan is already on smaller payments.", "not_available");
  const min = BigInt(lendingRules().restructuredMinimum) * 100n;
  const a = await store.createAction({
    user_id: user.id,
    kind: "loan_restructure",
    params: { loan_id: p.open.id, minimum: String(min) },
    readback: `Smaller payments: at least ${show(min)} every two weeks instead of ${show(p.open.minimum)}, until it is repaid. No extra cost.`,
    ttl_secs: ACTION_TTL_SECS,
  });
  return { text: `Smaller payments: ${say(min)} every two weeks instead of ${say(p.open.minimum)}, no extra cost. ${CHECK_SCREEN}`, ok: true, ...actionFields(a) };
};

// ---------------------------------------------------------------------------
// Help: what she can do, by voice or on the screen
// ---------------------------------------------------------------------------

/** "What can I do?": everything the app does, each one also by voice, and what is waiting for her. */
export const ngHelp: NgTool = async ({ user, store }) => {
  const [cash, pending] = await Promise.all([store.awaitingCashIns(user.id), store.pendingActions(user.id)]);
  const pin = say(BigInt(getMarket(M).pinThreshold) * 100n);
  const can = [
    "check her balance and what came in",
    "pay a saved person, or anyone by phone number (not on Plus: they get a code and collect cash at any agent)",
    "pay her ajo and hear who collects this round",
    "see her loan: her progress, her offer and why, repay, or ask for more time",
    "cash out with a 6-digit code an agent redeems",
    "add money: her bank account number for transfers, or cash with Mama Bisi",
    "hear her record on Stellar",
    "move to any screen: home, wallet, add money, pay, ajo, loan, cash out, activity, profile",
  ];
  const first: string[] = [];
  for (const c of cash) first.push(`${c.helper_name} says she gave ${say(c.amount)} cash: is that right?`);
  for (const a of pending.filter((x) => x.status === "pending")) first.push(`waiting for her Yes: ${a.readback}`);
  return {
    text: `She can do all of this by voice or on her screen: ${can.join("; ")}. ` +
      `Money up to ${pin} she confirms by saying yes; above ${pin}, she types her PIN on the screen, never out loud.` +
      (first.length ? ` First, waiting now: ${first.join("; ")}.` : "") +
      " Offer two or three of these in one short sentence; don't read the whole list.",
    ok: true,
    can,
    voice_yes_up_to_text: show(BigInt(getMarket(M).pinThreshold) * 100n),
    waiting: first,
  };
};

// ---------------------------------------------------------------------------

export const NG_VOICE_TOOLS: Record<string, NgTool> = {
  get_user: ngGetUser,
  help: ngHelp,
  get_balance: ngGetBalance,
  what_arrived: ngWhatArrived,
  prepare_pay: ngPreparePay,
  prepare_ajo_contribution: ngPrepareAjo,
  prepare_group_contribution: ngPrepareAjo, // same tool under the shared name
  prepare_cashout: ngPrepareCashout,
  // The 1.5% advance is retired from the app and the agent (its contract functions stay); loans replace it.
  loan_status: ngLoanStatus,
  prepare_loan: ngPrepareLoan,
  prepare_loan_repay: ngPrepareLoanRepay,
  loan_more_time: ngLoanMoreTime,
  loan_restructure: ngLoanRestructure,
  save_payee: ngSavePayee,
  bank_details: ngBankDetails,
  confirm_action: ngConfirmAction,
  reject_action: ngRejectAction,
  my_record: ngMyRecord,
  group_status: ngGroupStatus,
  cash_outs: ngCashOuts,
};

export const NG_APP_TOOLS: Record<string, NgTool> = {
  ...NG_VOICE_TOOLS,
  new_cashout_code: ngNewCashOutCode,
  simulate_bank_transfer: ngSimulateBankTransfer,
};
