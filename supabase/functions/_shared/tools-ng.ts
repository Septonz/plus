// Plus Nigeria tools: the user's Stellar wallet is her account. Same two-step rule as India
// (prepare -> confirm_action), but confirm_action only claims the action and queues the Stellar
// work in the chain outbox (one database transaction); it answers "sending" at once and the app
// shows the tick when chain-worker confirms the transaction on-chain.
//
// Voice and the app read balances only from the wallet_balances cache (refreshed from Horizon
// after every confirmed transaction and every minute). Contract state (ajo, advance, limit) is
// read from the contract's views. Amounts are kobo (bigint); spoken amounts are always naira.
import { formatMoney, formatSpokenMoney, getMarket } from "./markets.ts";
import type { ChainAdvance, ContractReader } from "./ng-types.ts";
import { matchPayee, parseMajorAmount, type Payee } from "./payees.ts";
import type { PinOutcome } from "./pin.ts";
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
  /** Stellar wallets of the active registered cash agents (they may claim cash-outs). */
  agentWallets(): Promise<string[]>;
  cashOuts(userId: string): Promise<CashOut[]>;
  /** Replace the code of her own issued cash-out (resets wrong attempts). */
  setCashOutCode(userId: string, cashOutId: string, codeHash: string): Promise<boolean>;
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

/** Money leaving her wallet above the market's PIN threshold needs the PIN, typed in the app. */
export function ngNeedsPin(a: Pick<Action, "kind" | "params">): boolean {
  if (!["pay", "group_contribution", "cash_out"].includes(a.kind)) return false;
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
  const incoming = txs.filter((t) => (t.kind === "incoming" || t.kind === "advance") && new Date(t.created_at).getTime() >= since).slice(0, 5);
  const parts: string[] = [];
  // Cash waiting for her Yes or No comes first.
  for (const c of cash) {
    parts.push(`${c.helper_name} says she gave ${say(c.amount)} cash ${whenSpoken(c.created_at, now)}. It enters her wallet only after she says it is right. Ask her: is that right?`);
  }
  const from = (t: NgTx) =>
    t.kind === "advance" ? "her advance" : t.source === "cash" ? "cash with the agent" : t.source === "ajo_payout" ? "her ajo payout" : "a deposit";
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
  cash_out: "cash out",
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
      label: KIND_WORDS[t.kind] ?? t.kind,
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
  const [g, txs] = await Promise.all([store.chain.group(mine.onchain_id), store.transactions(user.id, 100)]);
  if (!g) return refuse("I can't read the ajo from Stellar just now.", "chain_unavailable");
  const names = new Map(mine.members.map((m) => [m.position, m]));
  const myIndex = mine.members.find((m) => m.user_id === user.id)?.position ?? -1;
  const onTheWay = txs.some((t) => t.kind === "group_contribution" && t.source === mine.id && t.status === "pending");
  const mineLast = txs.find((t) => t.kind === "group_contribution" && t.chain_tx_hash);
  const members = g.members.map((_, i) => ({
    name: names.get(i)?.name ?? "Member",
    position: i,
    is_me: i === myIndex,
    paid_this_round: g.contributed[i] ?? false,
    verified_on_stellar: g.contributed[i] ?? false, // read from the contract itself
    is_turn: i === g.turn,
    url: i === myIndex && mineLast?.chain_tx_hash && explorer ? `${explorer}/tx/${mineLast.chain_tx_hash}` : null,
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
  const eligible = limit >= minMinor && !open;
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
    : "She can't take an advance yet.";
  return {
    text,
    eligible,
    open: Boolean(open),
    limit_minor: String(limit),
    limit_text: show(limit),
    fee_bps: rules.feeBps,
    repay_pct: repayPct,
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
  const [available, paidToday] = await Promise.all([store.available(user.id), store.paidSince(user.id, dayStart(M, now))]);
  if (available < amount) {
    return refuse(`Not enough money: she has ${say(available > 0n ? available : 0n)} to spend.`, "insufficient_funds", { available_text: show(available) });
  }
  const cap = BigInt(getMarket(M).payDailyLimit) * 100n;
  if (paidToday + amount > cap) {
    const left = cap > paidToday ? cap - paidToday : 0n;
    return refuse(`That is over today's limit. She can send ${say(left)} more today.`, "daily_limit", { left_today_text: show(left) });
  }
  return null;
}

function confirmText(a: Action): string {
  return ngNeedsPin(a) ? PIN_ON_SCREEN : CHECK_SCREEN;
}

export const ngPreparePay: NgTool = async ({ user, store, args, now = new Date() }) => {
  const amount = parseMajorAmount(args.amount);
  if (amount === null) return refuse("How much should she pay? Ask for the amount in naira.", "invalid_amount");
  const spoken = typeof args.payee === "string" ? args.payee : "";
  const payees = (await store.payees(user.id)).filter((p) => p.stellar_address);
  if (payees.length === 0) return refuse("She has no saved payees yet.", "no_payees");
  const match = matchPayee(spoken, payees);
  if (match.kind !== "match") {
    const names = match.options.map((p) => p.name);
    return refuse(
      match.kind === "ambiguous" ? `Which one: ${names.join(" or ")}? Ask her; don't guess.` : `"${spoken}" is not one of her saved payees: ${names.join(", ")}. Ask which one she means.`,
      match.kind === "ambiguous" ? "ambiguous_payee" : "unknown_payee",
      { options: match.options.map((p) => ({ id: p.id, name: p.name })) },
    );
  }
  const payee = match.payee;
  const blocked = await spendCheck(store, user, amount, now);
  if (blocked) return blocked;
  const a = await store.createAction({
    user_id: user.id,
    kind: "pay",
    params: { amount: String(amount), payee_id: payee.id, payee_name: payee.name, to: payee.stellar_address },
    readback: `${show(amount)} to ${payee.name}`,
    ttl_secs: ACTION_TTL_SECS,
  });
  return {
    text: `Read back: ${say(amount)} to ${payee.name}. ${confirmText(a)}`,
    ok: true,
    ...actionFields(a),
    payee: { id: payee.id, name: payee.name },
    amount_text: show(amount),
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
      `It pays itself back with ${pct} percent of every cash-in. ${CHECK_SCREEN}`,
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
    case "group_contribution":
      return `Okay: ${amt} for her ajo.${tail}`;
    case "advance":
      return `Okay: advance of ${amt}.${tail}`;
    case "cash_out":
      return `Okay: cash-out of ${amt}. Her code is on her screen; she shows it to the agent, and the agent gives her the cash.${tail}`;
    case "confirm_cash_in": {
      const repay = BigInt(String(r.repay ?? 0));
      return `Okay: ${amt} cash from ${String(r.helper_name ?? a.params.helper_name)} is going into her wallet.` +
        (repay > 0n ? ` ${say(repay)} of it pays back her advance.` : "") + tail;
    }
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
    if (a.kind === "cash_out") {
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
    cash_out_code: ok && claimed && code && channel === "app" ? code : undefined,
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

export const NG_VOICE_TOOLS: Record<string, NgTool> = {
  get_user: ngGetUser,
  get_balance: ngGetBalance,
  what_arrived: ngWhatArrived,
  prepare_pay: ngPreparePay,
  prepare_ajo_contribution: ngPrepareAjo,
  prepare_group_contribution: ngPrepareAjo, // same tool under the shared name
  prepare_advance: ngPrepareAdvance,
  prepare_cashout: ngPrepareCashout,
  confirm_action: ngConfirmAction,
  reject_action: ngRejectAction,
  my_record: ngMyRecord,
  group_status: ngGroupStatus,
  advance_status: ngAdvanceStatus,
  cash_outs: ngCashOuts,
};

export const NG_APP_TOOLS: Record<string, NgTool> = {
  ...NG_VOICE_TOOLS,
  new_cashout_code: ngNewCashOutCode,
};
