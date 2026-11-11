import { assert, assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert@1";
import { agentCashInCheck, agentCashInReadback, cashOutRedeemable, normalizeNgPhone, sameHex } from "./agent.ts";
import type { CreditAsset, CreditLoan, CreditWeek } from "./lending.ts";
import type { ChainAdvance, ChainGroup } from "./ng-types.ts";
import { parseMajorAmount } from "./payees.ts";
import type { Action } from "./tools.ts";
import {
  advanceFee,
  cashInRepayment,
  cashOutCodeHash,
  type NgContext,
  type NgStore,
  ngConfirmAction,
  ngHelp,
  ngLoanMoreTime,
  ngLoanStatus,
  ngNeedsPin,
  ngPrepareLoan,
  ngPrepareLoanRepay,
  ngPrepareAdvance,
  ngPrepareAjo,
  ngPrepareCashout,
  ngPreparePay,
  newCashOutCode,
  payoutSplit,
  ngGroupStatus,
  ngAdvanceStatus,
  ngSavePayee,
  ngSimulateBankTransfer,
  NG_VOICE_TOOLS,
  type PlusPeer,
} from "./tools-ng.ts";

const FUNMI = "GA6K725VCN45F4LWZYEL3H7J5CIGGL2IUXDWZH5X75GYWQQJNPAYGW6M";
const TUNDE = "GCBLFDJE43YENUQXRDPDS2SO5P4TSC7WUOZICRJWZO66W3KVZTYSP2WK";
const AGENT = "GAOZ6FG534DO26FMGH2YLMV6X2VFZJT5HIKDJCEDMMOIM2JYRFPPSOJ2";
const N = (naira: number) => BigInt(naira) * 100n; // naira -> kobo

type World = {
  available: bigint;
  paidToday: bigint;
  limit: bigint;
  advance: ChainAdvance | null;
  pool: bigint;
  group: ChainGroup | null;
  actions: Map<string, Action>;
  executed: { id: string; extra: Record<string, unknown> }[];
  /** Other Plus users by phone, with their balances. */
  peers: Map<string, PlusPeer & { balance: bigint }>;
  saved: { name: string; phone: string; stellar_address: string | null }[];
  /** Saved bank accounts (piece 7). */
  bankPayees: { id: string; name: string; bank_code: string; account_number: string; account_name: string }[];
  bankIns: { amount: bigint; repay: bigint; ref: string }[];
  credit: { frozen_until: string | null; weeks: CreditWeek[]; assets: CreditAsset[]; loans: CreditLoan[] };
};

function fakeStore(w: World): NgStore {
  let n = 0;
  return {
    balances: (id) => {
      const peer = [...w.peers.values()].find((p) => p.id === id);
      return Promise.resolve({ NGNT: peer ? peer.balance : w.available, USDC: 0n, updated_at: "2026-11-09T00:00:00Z" });
    },
    refreshBalances: () => Promise.resolve(),
    available: () => Promise.resolve(w.available),
    hasPin: () => Promise.resolve(true),
    verifyPin: (_u, pin) => Promise.resolve(pin === "1234" ? { ok: true } : { ok: false, outcome: "wrong", attemptsLeft: 2 }) as never,
    payees: () => Promise.resolve([{ id: "p1", name: "Iya Tunde (tomato wholesaler)", stellar_address: TUNDE }, ...w.bankPayees]),
    paidSince: () => Promise.resolve(w.paidToday),
    createAction: (a) => {
      const action: Action = {
        id: `00000000-0000-0000-0000-00000000000${++n}`,
        user_id: a.user_id,
        kind: a.kind,
        params: a.params,
        readback: a.readback,
        status: "pending",
        result: null,
        expires_at: new Date(Date.now() + a.ttl_secs * 1000).toISOString(),
        created_by: "user",
        created_at: new Date().toISOString(),
      };
      w.actions.set(action.id, action);
      return Promise.resolve(action);
    },
    action: (id) => Promise.resolve(w.actions.get(id) ?? null),
    pendingActions: () => Promise.resolve([...w.actions.values()].filter((a) => a.status === "pending")),
    execute: (id, _u, extra) => {
      const a = w.actions.get(id)!;
      if (a.status !== "pending") return Promise.resolve({ action: a, claimed: false });
      w.executed.push({ id, extra });
      const moves = a.params.amount !== undefined;
      const done: Action = {
        ...a, status: "done",
        result: moves ? { ok: true, sending: true, amount: a.params.amount, transaction_id: "t1", repay: extra.repay ?? 0 }
          : { ok: true, sending: false, amount: null, transaction_id: null, next_due_at: a.params.new_due_at ?? null, minimum: a.params.minimum ?? null },
      };
      w.actions.set(id, done);
      return Promise.resolve({ action: done, claimed: true });
    },
    rejectAction: (id) => Promise.resolve({ ...w.actions.get(id)!, status: "rejected" }),
    awaitingCashIns: () => Promise.resolve([]),
    transactions: () => Promise.resolve([]),
    myGroup: () =>
      Promise.resolve({
        id: "g1",
        name: "Bodija Market Ajo",
        onchain_id: 3,
        members: ["Amaka", "Funmi", "Tunde", "Halima", "Kemi"].map((name, position) => ({ name, position, user_id: name === "Funmi" ? "u1" : null })),
      }),
    contributionTxs: () => Promise.resolve(new Map()),
    agentWallets: () => Promise.resolve([AGENT]),
    cashOuts: () => Promise.resolve([]),
    setCashOutCode: () => Promise.resolve(true),
    plusUserByPhone: (phone) => {
      const p = w.peers.get(phone);
      return Promise.resolve(p ? { id: p.id, name: p.name, market_id: p.market_id, kyc_tier: p.kyc_tier, stellar_pub: p.stellar_pub } : null);
    },
    pendingIncoming: () => Promise.resolve(0n),
    savePayee: (_u, p) => {
      w.saved.push(p);
      return Promise.resolve({ id: `p${w.saved.length + 1}`, name: p.name, phone: p.phone, stellar_address: p.stellar_address });
    },
    saveBankPayee: (_u, p) => {
      const saved = { id: `b${w.bankPayees.length + 1}`, ...p };
      w.bankPayees.push(saved);
      return Promise.resolve(saved);
    },
    bankTransferIn: (_u, amount, repay, ref) => {
      w.bankIns.push({ amount, repay, ref });
      return Promise.resolve({ transaction_id: "bank-t1", repay });
    },
    credit: () => Promise.resolve({ ...w.credit, events: [] }),
    chain: {
      group: () => Promise.resolve(w.group),
      advanceOf: () => Promise.resolve(w.advance),
      limitOf: () => Promise.resolve(w.limit),
      poolBalance: () => Promise.resolve(w.pool),
    },
  };
}

function setup(over: Partial<World> = {}) {
  const w: World = {
    available: N(26_400),
    paidToday: 0n,
    limit: N(20_000),
    advance: null,
    pool: N(200_000),
    group: {
      members: ["A", FUNMI, "B", "C", "D"],
      amount_minor: N(1_000),
      period_secs: 86_400,
      next_due: new Date(Date.now() + 3_600_000),
      turn: 0,
      pot_minor: N(4_000),
      pooled: true,
      contributed: [true, false, true, true, true],
    },
    actions: new Map(),
    executed: [],
    peers: new Map(),
    saved: [],
    bankPayees: [],
    bankIns: [],
    credit: { frozen_until: null, weeks: [], assets: [], loans: [] },
    ...over,
  };
  const ctx = (args: Record<string, unknown> = {}, channel: "voice" | "app" = "voice", user: Partial<NgContext["user"]> = {}): NgContext => ({
    user: {
      id: "u1",
      market_id: "ng",
      name: "Funmi",
      language: "en",
      kyc_tier: 2,
      member_since: "2026-06-01T00:00:00Z",
      virtual_account: "9000010001",
      stellar_pub: FUNMI,
      auto_save_bps: 0,
      ref_hash: null,
      trusted_contact_phone: null,
      ...user,
    },
    channel,
    store: fakeStore(w),
    args,
    ngntSac: "CBP33BBVB2646GFQ2ENOXBYPVZUZHLHVBXLXTQ5DBKLEBTPVVBEYJPLV",
    codeSecret: "test-secret-0123456789abcdef0123456789abcdef",
  });
  return { w, ctx };
}

// --- amounts -------------------------------------------------------------------------------------

Deno.test("naira amounts as said: ₦, N, naira, 20k; never floats", () => {
  assertEquals(parseMajorAmount("₦5,000"), N(5_000));
  assertEquals(parseMajorAmount("N500"), N(500));
  assertEquals(parseMajorAmount("20k"), N(20_000));
  assertEquals(parseMajorAmount("20,000 naira"), N(20_000));
  assertEquals(parseMajorAmount("1.5k"), null);
  assertEquals(parseMajorAmount("-5"), null);
});

// --- advance: fee and limit ------------------------------------------------------------------------

Deno.test("advance fee: 1.5% of the amount, integer kobo (₦20,000 -> ₦300)", () => {
  assertEquals(advanceFee(N(20_000)), N(300));
  assertEquals(advanceFee(N(5_000)), N(75));
  assertEquals(advanceFee(333n), 4n); // rounds down, like the contract
});

Deno.test("advance read-back states the fee in naira, no interest, no late fees, 10% of each cash-in", async () => {
  const { w, ctx } = setup();
  const r = await ngPrepareAdvance(ctx({ amount: "20000" }));
  assertEquals(r.ok, true);
  assertMatch(r.text, /20,000 naira/);
  assertMatch(r.text, /fee is 300 naira/);
  assertMatch(r.text, /No interest and no late fees/);
  assertMatch(r.text, /10 percent of every cash-in/);
  // Above ₦5,000 a voice yes is not enough: the PIN, on her screen.
  assertMatch(r.text, /type her PIN there/);
  assertEquals(r.requires_pin, true);
  const a = [...w.actions.values()][0];
  assertEquals(a.kind, "advance");
  assertEquals(a.params.amount, "2000000");
  assertEquals(a.params.fee, "30000");
});

Deno.test("advance refused: over her limit, below the minimum, or one already open", async () => {
  const over = await ngPrepareAdvance(setup().ctx({ amount: "25000" }));
  assertEquals(over.error, "over_limit");
  const low = await ngPrepareAdvance(setup().ctx({ amount: "1000" }));
  assertEquals(low.error, "below_min");
  const open = await ngPrepareAdvance(
    setup({ advance: { principal_minor: N(20_000), fee_minor: N(300), owed_minor: N(10_000), opened_at: new Date() } }).ctx({ amount: "5000" }),
  );
  assertEquals(open.error, "advance_open");
  const pool = await ngPrepareAdvance(setup({ pool: N(1_000) }).ctx({ amount: "5000" }));
  assertEquals(pool.error, "pool_low");
});

// --- auto-repay on cash-in ---------------------------------------------------------------------------

Deno.test("cash-in repays 10% of itself to an open advance, never more than owed", () => {
  const adv = (owed: number): ChainAdvance => ({ principal_minor: N(20_000), fee_minor: N(300), owed_minor: N(owed), opened_at: new Date() });
  assertEquals(cashInRepayment(N(500), null), 0n);
  assertEquals(cashInRepayment(N(500), adv(20_300)), N(50));
  assertEquals(cashInRepayment(N(3_000), adv(120)), N(120));
  assertEquals(cashInRepayment(N(500), adv(0)), 0n);
});

Deno.test("confirming a cash-in with an advance open queues the 10% repayment with it", async () => {
  const { w, ctx } = setup({ advance: { principal_minor: N(20_000), fee_minor: N(300), owed_minor: N(20_300), opened_at: new Date() } });
  const store = ctx().store;
  const a = await store.createAction({ user_id: "u1", kind: "confirm_cash_in", params: { amount: "50000", helper_name: "Mama Bisi" }, readback: "x", ttl_secs: 60 });
  const r = await ngConfirmAction({ ...ctx({ action_id: a.id }), store });
  assertEquals(r.ok, true);
  assertEquals(w.executed[0].extra.repay, "5000"); // ₦50 of ₦500
  assertMatch(r.text, /50 naira of it pays back her advance/);
  assertEquals(r.sending, true);
});

// --- ajo payout repays an advance first ---------------------------------------------------------------

Deno.test("ajo payout: the recipient's open advance is repaid from the pot first", () => {
  const adv = (owed: number): ChainAdvance => ({ principal_minor: N(1), fee_minor: 0n, owed_minor: N(owed), opened_at: new Date() });
  assertEquals(payoutSplit(N(5_000), null), { repaid: 0n, net: N(5_000) });
  assertEquals(payoutSplit(N(5_000), adv(2_030)), { repaid: N(2_030), net: N(2_970) });
  assertEquals(payoutSplit(N(5_000), adv(20_300)), { repaid: N(5_000), net: 0n });
});

// --- pay and ajo ---------------------------------------------------------------------------------------

Deno.test("pay Iya Tunde: NGNT to her Stellar wallet, read back in naira", async () => {
  const { w, ctx } = setup();
  const r = await ngPreparePay(ctx({ payee: "Iya Tunde", amount: "5000" }));
  assertEquals(r.ok, true);
  assertMatch(r.text, /5,000 naira to Iya Tunde/);
  const a = [...w.actions.values()][0];
  assertEquals(a.params.to, TUNDE);
  assertEquals(a.params.amount, "500000");
  assertEquals(ngNeedsPin(a), false);
  const tomato = await ngPreparePay(ctx({ payee: "the tomato woman", amount: "100" }));
  assertEquals(tomato.ok, true);
  const broke = await ngPreparePay(setup({ available: N(100) }).ctx({ payee: "Iya Tunde", amount: "5000" }));
  assertEquals(broke.error, "insufficient_funds");
  const capped = await ngPreparePay(setup({ paidToday: N(199_000) }).ctx({ payee: "Iya Tunde", amount: "5000" }));
  assertEquals(capped.error, "daily_limit");
});

Deno.test("above ₦5,000 money leaving needs the PIN, typed on screen, never by voice", async () => {
  const { ctx } = setup({ available: N(100_000) });
  const store = ctx().store;
  const r = await ngPreparePay({ ...ctx({ payee: "Iya Tunde", amount: "25000" }), store });
  assertEquals(r.requires_pin, true);
  const byVoice = await ngConfirmAction({ ...ctx({ action_id: r.action_id }), store });
  assertEquals(byVoice.error, "pin_required_on_screen");
  const pinByVoice = await ngConfirmAction({ ...ctx({ action_id: r.action_id, pin: "1234" }), store });
  assertEquals(pinByVoice.error, "pin_not_allowed_by_voice");
  const app = await ngConfirmAction({ ...ctx({ action_id: r.action_id, pin: "1234" }, "app"), store });
  assertEquals(app.ok, true);
  // ₦5,000 exactly: her spoken yes is enough.
  const edge = await ngPreparePay({ ...ctx({ payee: "Iya Tunde", amount: "5000" }), store });
  assertEquals(edge.requires_pin, false);
  assertEquals((await ngConfirmAction({ ...ctx({ action_id: edge.action_id }), store })).ok, true);
  const over = await ngPreparePay({ ...ctx({ payee: "Iya Tunde", amount: "5001" }), store });
  assertEquals(over.requires_pin, true);
});

Deno.test("help: says what she can do, the voice-yes limit, and what is waiting first", async () => {
  const { ctx } = setup();
  const r = await ngHelp(ctx());
  assertEquals(r.ok, true);
  assertMatch(r.text, /pay a saved person/);
  assertMatch(r.text, /up to 5,000 naira she confirms by saying yes/);
  assertMatch(r.text, /move to any screen/);
});

Deno.test("ajo contribution: only if her part of this round is not paid yet", async () => {
  const r = await ngPrepareAjo(setup().ctx());
  assertEquals(r.ok, true);
  assertMatch(r.text, /1,000 naira for Bodija Market Ajo/);
  const { ctx } = setup();
  const paid = await ngPrepareAjo({
    ...ctx(),
    store: { ...ctx().store, chain: { ...ctx().store.chain, group: () => Promise.resolve({ ...setup().w.group!, contributed: [true, true, true, true, true] }) } },
  });
  assertEquals(paid.error, "already_paid");
});

// --- cash-out codes -------------------------------------------------------------------------------------

Deno.test("cash-out code: 6 digits, stored only as an HMAC bound to the user", async () => {
  const code = newCashOutCode();
  assertMatch(code, /^\d{6}$/);
  const h = await cashOutCodeHash("k".repeat(32), "u1", code);
  assertMatch(h, /^[0-9a-f]{64}$/);
  assertEquals(h, await cashOutCodeHash("k".repeat(32), "u1", code));
  assertNotEquals(h, await cashOutCodeHash("k".repeat(32), "u2", code));
  assertNotEquals(h, await cashOutCodeHash("j".repeat(32), "u1", code));
  assert(sameHex(h, h));
  assert(!sameHex(h, h.replace(/.$/, h.endsWith("0") ? "1" : "0")));
});

Deno.test("cash-out confirm: code shown once on the app, never sent to the voice agent", async () => {
  const { w, ctx } = setup();
  const store = ctx().store;
  const r = await ngPrepareCashout({ ...ctx({ amount: "5000" }), store });
  assertEquals(r.ok, true);
  assertEquals((w.actions.get(r.action_id as string)!.params.claimants as string[])[0], AGENT);
  const app = await ngConfirmAction({ ...ctx({ action_id: r.action_id }, "app"), store });
  assertMatch(String(app.cash_out_code), /^\d{6}$/);
  assertMatch(String(w.executed[0].extra.code_hash), /^[0-9a-f]{64}$/);
  const retry = await ngConfirmAction({ ...ctx({ action_id: r.action_id }, "app"), store });
  assertEquals(retry.cash_out_code, undefined); // stored result only; no new code, nothing queued twice
  assertEquals(w.executed.length, 1);

  const v = setup();
  const vs = v.ctx().store;
  const r2 = await ngPrepareCashout({ ...v.ctx({ amount: "5000" }), store: vs });
  const voice = await ngConfirmAction({ ...v.ctx({ action_id: r2.action_id }), store: vs });
  assertEquals(voice.ok, true);
  assertEquals(voice.cash_out_code, undefined);
});

Deno.test("cash-out redeem: before expiry, unused, under 5 wrong codes", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  const later = "2026-11-17T12:00:00Z";
  assertEquals(cashOutRedeemable({ status: "issued", expires_at: later, attempts: 0 }, now, 5), { ok: true });
  assertEquals(cashOutRedeemable({ status: "issued", expires_at: later, attempts: 5 }, now, 5), { ok: false, error: "too_many_attempts" });
  assertEquals(cashOutRedeemable({ status: "redeemed", expires_at: later, attempts: 0 }, now, 5), { ok: false, error: "not_redeemable" });
  assertEquals(cashOutRedeemable({ status: "issued", expires_at: "2026-11-10T11:59:59Z", attempts: 0 }, now, 5), { ok: false, error: "code_expired" });
});

// --- agent: daily limit and float -------------------------------------------------------------------

Deno.test("agent cash-in: within her daily limit and her free float", () => {
  const base = { used: N(100_000), limit: N(500_000), float: N(200_000), committed: N(0), amount: N(500) };
  assertEquals(agentCashInCheck(base).ok, true);
  const limit = agentCashInCheck({ ...base, used: N(499_800) });
  assertEquals(limit.ok ? null : limit.error, "daily_limit_exceeded");
  const float = agentCashInCheck({ ...base, float: N(1_000), committed: N(600) });
  assertEquals(float.ok ? null : float.error, "float_too_low");
  assertEquals(agentCashInReadback("Mama Bisi", N(500)), "Mama Bisi says you gave her ₦500. Is that right?");
});

Deno.test("agent finds customers by Nigerian phone number", () => {
  assertEquals(normalizeNgPhone("0803 123 4567"), "+2348031234567");
  assertEquals(normalizeNgPhone("+234 803 123 4567"), "+2348031234567");
  assertEquals(normalizeNgPhone("2348031234567"), "+2348031234567");
  assertEquals(normalizeNgPhone("+91 98765 43210"), null);
});

Deno.test("ajo ticks link to each member's own contribution on Stellar", async () => {
  const { ctx } = setup();
  const hash = "ab".repeat(32);
  const r = await ngGroupStatus({
    ...ctx(),
    explorer: "https://stellar.expert/explorer/testnet",
    store: { ...ctx().store, contributionTxs: () => Promise.resolve(new Map([["A", hash]])) },
  });
  const m = r.members as { paid_this_round: boolean; url: string | null }[];
  assertEquals(m[0].url, `https://stellar.expert/explorer/testnet/tx/${hash}`); // paid, event indexed
  assertEquals(m[1].url, null); // Funmi has not paid this round
  assertEquals(m[2].paid_this_round, true);
  assertEquals(m[2].url, null); // paid on the contract, event not indexed yet: no link rather than a wrong one
});

// --- KYC tiers -----------------------------------------------------------------------------------------

Deno.test("tier limits: tier 0 moves nothing, tier 1 caps the day at ₦50,000, tier 2 at ₦200,000", async () => {
  const { ctx } = setup({ available: N(400_000) });
  const t0 = await ngPreparePay(ctx({ payee: "Iya Tunde", amount: "100" }, "voice", { kyc_tier: 0 }));
  assertEquals(t0.error, "signup_not_finished");
  const t1ok = await ngPreparePay(ctx({ payee: "Iya Tunde", amount: "50000" }, "voice", { kyc_tier: 1 }));
  assertEquals(t1ok.ok, true);
  const t1over = await ngPreparePay(ctx({ payee: "Iya Tunde", amount: "50001" }, "voice", { kyc_tier: 1 }));
  assertEquals(t1over.error, "daily_limit");
  assertMatch(t1over.text, /NIN raises the limit/);
  const t2 = await ngPreparePay(ctx({ payee: "Iya Tunde", amount: "150000" }, "voice", { kyc_tier: 2 }));
  assertEquals(t2.ok, true);
  const cash = await ngPrepareCashout(ctx({ amount: "60000" }, "voice", { kyc_tier: 1 }));
  assertEquals(cash.error, "daily_limit");
});

Deno.test("tier limits: no advances at tier 1, and only after 8 weeks at tier 2", async () => {
  const { ctx } = setup();
  const t1 = await ngPrepareAdvance(ctx({ amount: "10000" }, "voice", { kyc_tier: 1 }));
  assertEquals(t1.error, "tier_too_low");
  const status1 = await ngAdvanceStatus(ctx({}, "voice", { kyc_tier: 1 }));
  assertEquals(status1.eligible, false);
  assertMatch(status1.text, /NIN is checked/);
  const fresh = await ngPrepareAdvance(ctx({ amount: "10000" }, "voice", { kyc_tier: 2, member_since: new Date(Date.now() - 3 * 7 * 86_400_000).toISOString() }));
  assertEquals(fresh.error, "too_new");
  assertMatch(fresh.text, /5 more weeks/);
  const ok = await ngPrepareAdvance(ctx({ amount: "10000" }));
  assertEquals(ok.ok, true);
});

Deno.test("tier limits: a payment that would take the recipient over their balance limit is refused", async () => {
  const peers = new Map([["+2347000000201", { id: "u2", name: "Bola", market_id: "ng" as const, kyc_tier: 1, stellar_pub: TUNDE, balance: N(295_000) }]]);
  const { ctx } = setup({ peers });
  const r = await ngPreparePay(ctx({ phone: "0700 000 0201", amount: "10000" }));
  assertEquals(r.error, "recipient_full");
  assertMatch(r.text, /Bola's wallet/);
  const fits = await ngPreparePay(ctx({ phone: "0700 000 0201", amount: "5000" }));
  assertEquals(fits.ok, true);
});

// --- paying anyone by phone --------------------------------------------------------------------------------

Deno.test("pay a Plus user by phone: NGNT straight to their wallet, their side recorded too", async () => {
  const peers = new Map([["+2347000000201", { id: "u2", name: "Bola", market_id: "ng" as const, kyc_tier: 2, stellar_pub: TUNDE, balance: 0n }]]);
  const { w, ctx } = setup({ peers });
  const r = await ngPreparePay(ctx({ phone: "+234 700 000 0201", amount: "2500" }));
  assertEquals(r.ok, true);
  assertEquals(r.kind, "pay");
  assertMatch(r.text, /Bola is on Plus/);
  const a = [...w.actions.values()][0];
  assertEquals(a.params.to, TUNDE);
  assertEquals(a.params.to_user_id, "u2");
  assertEquals(a.params.phone, "+2347000000201");
  const self = await ngPreparePay(setup({ peers: new Map([["+2347000000101", { id: "u1", name: "Funmi", market_id: "ng" as const, kyc_tier: 2, stellar_pub: FUNMI, balance: 0n }]]) }).ctx({ phone: "07000000101", amount: "100" }));
  assertEquals(self.error, "own_number");
  const bad = await ngPreparePay(ctx({ phone: "12345", amount: "100" }));
  assertEquals(bad.error, "invalid_phone");
});

Deno.test("pay someone not on Plus: a code they collect at an agent; the SMS shows on her screen, never to voice", async () => {
  const { w, ctx } = setup({ available: N(100_000) });
  const r = await ngPreparePay(ctx({ phone: "0803 555 0101", name: "Mama Ngozi", amount: "3000" }));
  assertEquals(r.ok, true);
  assertEquals(r.kind, "pay_code");
  assertMatch(r.text, /not on Plus yet/);
  const a = [...w.actions.values()][0];
  assertEquals(a.params.claimants, [AGENT]);
  assertEquals(a.params.phone, "+2348035550101");
  const store = ctx().store;
  const byVoice = await ngConfirmAction({ ...ctx({ action_id: r.action_id }), store });
  assertEquals(byVoice.ok, true);
  assertEquals(byVoice.pay_code_sms, undefined);
  assertEquals(byVoice.cash_out_code, undefined);
  assertMatch(String(w.executed[0].extra.code_hash), /^[0-9a-f]{64}$/);

  const r2 = await ngPreparePay(ctx({ phone: "08035550101", amount: "1000" }));
  const app = await ngConfirmAction({ ...ctx({ action_id: r2.action_id }, "app"), store });
  const sms = app.pay_code_sms as { to: string; code: string; text: string };
  assertEquals(sms.to, "+2348035550101");
  assertMatch(sms.code, /^\d{6}$/);
  assertMatch(sms.text, /Funmi sent you ₦1,000/);
  assertEquals(app.cash_out_code, undefined); // her own cash-out code field stays empty
  // Only the HMAC was stored, bound to the sender.
  assertEquals(w.executed[1].extra.code_hash, await cashOutCodeHash("test-secret-0123456789abcdef0123456789abcdef", "u1", sms.code));
  // Above ₦5,000 it needs the PIN like any money leaving her wallet.
  const big = await ngPreparePay(ctx({ phone: "08035550101", amount: "25000" }));
  assertEquals(big.requires_pin, true);
});

Deno.test("save this person after a payment: by phone, with their wallet if they are on Plus", async () => {
  const peers = new Map([["+2347000000201", { id: "u2", name: "Bola", market_id: "ng" as const, kyc_tier: 2, stellar_pub: TUNDE, balance: 0n }]]);
  const { w, ctx } = setup({ peers });
  const r = await ngSavePayee(ctx({ name: "Bola (pepper)", phone: "07000000201" }, "app"));
  assertEquals(r.ok, true);
  assertEquals(w.saved[0], { name: "Bola (pepper)", phone: "+2347000000201", stellar_address: TUNDE });
  const outsider = await ngSavePayee(ctx({ name: "Mama Ngozi", phone: "08035550101" }, "app"));
  assertEquals(outsider.ok, true);
  assertEquals(w.saved[1].stellar_address, null);
  assertEquals((await ngSavePayee(ctx({ name: "X", phone: "0803" }, "app"))).error, "invalid_phone");
});

// --- bank transfer in ------------------------------------------------------------------------------------

Deno.test("bank transfer in: demo button only, inside her balance limit, 10% repays an open advance", async () => {
  const { w, ctx } = setup();
  const voice = await ngSimulateBankTransfer(ctx({ amount: "5000" }));
  assertEquals(voice.error, "app_only");
  const r = await ngSimulateBankTransfer(ctx({ amount: "5000", sender: "Chidi Okeke" }, "app"));
  assertEquals(r.ok, true);
  assertMatch(r.text, /bank transfer from Chidi Okeke/);
  assertEquals(w.bankIns[0].amount, N(5_000));
  assertEquals(w.bankIns[0].repay, 0n);

  const withAdvance = setup({ advance: { principal_minor: N(10_000), fee_minor: N(150), owed_minor: N(10_150), opened_at: new Date() } });
  const r2 = await ngSimulateBankTransfer(withAdvance.ctx({ amount: "5000" }, "app"));
  assertEquals(withAdvance.w.bankIns[0].repay, N(500));
  assertMatch(r2.text, /500 naira of it pays back her advance/);

  const full = await ngSimulateBankTransfer(setup({ available: N(480_000) }).ctx({ amount: "50000" }, "app"));
  assertEquals(full.error, "balance_limit");
  const noWallet = await ngSimulateBankTransfer(ctx({ amount: "100" }, "app", { stellar_pub: null }));
  assertEquals(noWallet.error, "no_wallet");
});

// --- loans (piece 4) -----------------------------------------------------------------------------

const STOCK = { id: "a1", type: "stock", description: "Stall stock (tomatoes)", estimated_value: N(90_000), level: "independently_verified" as const, status: "active" };
const fullWeeks = (to: number) => Array.from({ length: to }, (_, i) => ({ week: i + 1, money_in: N(12_500), qualifying_tx: 6, saved: N(1_000) }));

Deno.test("loans: Kemi sees her progress and an estimate, and can't accept anything yet", async () => {
  const { ctx } = setup({ credit: { frozen_until: null, weeks: fullWeeks(3), assets: [], loans: [] } });
  const kemi = { member_since: new Date(Date.now() - 23 * 86_400_000).toISOString() };
  const s = await ngLoanStatus(ctx({}, "voice", kemi));
  assertEquals(s.view, "building");
  assertEquals(s.week, 4);
  assertMatch(String(s.text), /week 4 of 6/);
  assert(!/rejected|not eligible/i.test(JSON.stringify({ ...s, text: "" })));
  const p = await ngPrepareLoan(ctx({}, "voice", kemi));
  assertEquals(p.error, "still_building");
});

Deno.test("loans: Funmi's offer, why, and the PIN to accept; never above the offer", async () => {
  const { w, ctx } = setup({ credit: { frozen_until: null, weeks: fullWeeks(24), assets: [STOCK], loans: [] } });
  const s = await ngLoanStatus(ctx());
  assertEquals(s.view, "offer");
  const offer = s.offer as Record<string, string>;
  assertEquals([offer.amount_text, offer.cost_text, offer.total_text], ["₦30,000", "₦1,800", "₦31,800"]);
  assertMatch(String(s.text), /activity 40%, verified assets 35%, savings consistency 25%/);
  const over = await ngPrepareLoan(ctx({ amount: "40000" }));
  assertEquals(over.error, "over_offer");
  const p = await ngPrepareLoan(ctx());
  assertEquals(p.ok, true);
  const a = w.actions.get(String(p.action_id))!;
  assertEquals(a.kind, "loan");
  assertEquals(a.params.amount, String(N(30_000)));
  assertEquals(a.params.total, String(N(31_800)));
  assert(ngNeedsPin(a), "accepting a loan always takes the PIN");
  assert(ngNeedsPin({ kind: "loan", params: { amount: "100" } }));
});

Deno.test("loans: repay and more time while a loan is open; one loan at a time", async () => {
  const open = {
    id: "l1", step: 0, principal: N(30_000), cost: N(1_800), total: N(31_800), repaid: N(5_000), in_flight: 0n, period_paid: 0n,
    outstanding: N(26_800), minimum: N(2_500), repay_bps: 1000, every_days: 14, collateral_pct: 150, status: "active" as const,
    next_due_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), grace_until: null, missed: 0, extended_once: false,
    restructured_once: false, borrowing_paused: false, closed_by_reset: false, disbursed: "completed", created_at: new Date().toISOString(),
  };
  const { w, ctx } = setup({ credit: { frozen_until: null, weeks: fullWeeks(24), assets: [STOCK], loans: [open] } });
  const s = await ngLoanStatus(ctx());
  assertEquals(s.view, "repay");
  assertEquals((await ngPrepareLoan(ctx())).error, "loan_open");
  const r = await ngPrepareLoanRepay(ctx({ amount: "10000" }));
  assertEquals(w.actions.get(String(r.action_id))!.params.amount, String(N(10_000)));
  assertEquals((await ngPrepareLoanRepay(ctx())).error, "insufficient_funds"); // ₦26,800 owed, ₦26,400 in her wallet
  w.available = N(40_000);
  const all = await ngPrepareLoanRepay(ctx({ amount: "50000" }));
  assertEquals(w.actions.get(String(all.action_id))!.params.amount, String(N(26_800))); // never more than she owes
  const more = await ngLoanMoreTime(ctx());
  assertEquals(more.ok, true);
  assertEquals(w.actions.get(String(more.action_id))!.kind, "loan_extension");
  const yes = await ngConfirmAction(ctx({ action_id: more.action_id }, "app"));
  assertEquals(yes.status, "done");
  assertEquals(yes.transaction_id, null); // no money moves: the screen shows Done without waiting for a tick
  assertMatch(String(yes.text), /next payment is now due/);
  const again = await ngLoanMoreTime(setup({ credit: { frozen_until: null, weeks: [], assets: [], loans: [{ ...open, extended_once: true }] } }).ctx());
  assertEquals(again.error, "already_extended");
});

// ---------------------------------------------------------------------------- Send to a bank account (piece 7)

Deno.test("bank_lookup: the simulated name enquiry, before anything is sent", async () => {
  const { ctx } = setup();
  const r = await NG_VOICE_TOOLS.bank_lookup(ctx({ bank: "Ironwood", account_number: "012 345 6789" }));
  assert(r.ok, r.text);
  assertEquals(r.account_name, "ADEBAYO STORES");
  assertEquals(r.account_text, "•••• 6789");
  assertEquals((await NG_VOICE_TOOLS.bank_lookup(ctx({ bank: "Ironwood", account_number: "12345" }))).error, "invalid_account");
  assertEquals((await NG_VOICE_TOOLS.bank_lookup(ctx({ bank: "Some Real Bank", account_number: "0123456789" }))).error, "invalid_bank");
  assertEquals((await NG_VOICE_TOOLS.bank_lookup(ctx({ bank: "D01", account_number: "9990000001" }))).error, "account_not_found");
});

Deno.test("prepare_bank_send: by account number, read back with the name, PIN above the threshold", async () => {
  const { ctx, w } = setup();
  const r = await NG_VOICE_TOOLS.prepare_bank_send(ctx({ amount: "8000", bank: "Ironwood Bank", account_number: "0123456789" }));
  assert(r.ok, r.text);
  assert(String(r.text).includes("ADEBAYO STORES") && String(r.text).includes("ending 6 7 8 9"), r.text);
  const a = w.actions.get(String(r.action_id))!;
  assertEquals(a.kind, "bank_send");
  assertEquals(a.params.amount, String(N(8_000)));
  assertEquals(a.params.account_number, "0123456789");
  assertEquals(r.requires_pin, true, "₦8,000 is above the ₦5,000 voice-Yes threshold");
  const small = await NG_VOICE_TOOLS.prepare_bank_send(ctx({ amount: "2000", bank: "D01", account_number: "0123456789" }));
  assertEquals(small.requires_pin, false);
  const c = await NG_VOICE_TOOLS.confirm_action(ctx({ action_id: small.action_id }));
  assert(c.ok && String(c.text).includes("partner bank"), c.text);
});

Deno.test("prepare_bank_send: \"my landlord's bank account\" from a saved bank payee", async () => {
  const { ctx, w } = setup();
  const saved = await NG_VOICE_TOOLS.save_payee(ctx({ name: "Landlord", bank: "Ironwood", account_number: "0123456789" }));
  assert(saved.ok, saved.text);
  assertEquals(w.bankPayees[0].account_name, "ADEBAYO STORES");
  const r = await NG_VOICE_TOOLS.prepare_bank_send(ctx({ amount: "8000", payee: "my landlord's bank account" }));
  assert(r.ok, r.text);
  assertEquals(w.actions.get(String(r.action_id))!.params.payee_name, "Landlord");
  const none = await NG_VOICE_TOOLS.prepare_bank_send(ctx({ amount: "8000", payee: "my brother" }));
  assertEquals(none.error, "unknown_payee");
});

Deno.test("prepare_bank_send: the daily limit and her balance still apply", async () => {
  const { ctx } = setup({ available: N(1_000) });
  const r = await NG_VOICE_TOOLS.prepare_bank_send(ctx({ amount: "8000", bank: "D01", account_number: "0123456789" }));
  assert(!r.ok);
});
