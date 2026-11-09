import { assert, assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert@1";
import { agentCashInCheck, agentCashInReadback, cashOutRedeemable, normalizeNgPhone, sameHex } from "./agent.ts";
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
  ngNeedsPin,
  ngPrepareAdvance,
  ngPrepareAjo,
  ngPrepareCashout,
  ngPreparePay,
  newCashOutCode,
  payoutSplit,
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
};

function fakeStore(w: World): NgStore {
  let n = 0;
  return {
    balances: () => Promise.resolve({ NGNT: w.available, USDC: 0n, updated_at: "2026-11-09T00:00:00Z" }),
    refreshBalances: () => Promise.resolve(),
    available: () => Promise.resolve(w.available),
    hasPin: () => Promise.resolve(true),
    verifyPin: (_u, pin) => Promise.resolve(pin === "1234" ? { ok: true } : { ok: false, outcome: "wrong", attemptsLeft: 2 }) as never,
    payees: () => Promise.resolve([{ id: "p1", name: "Iya Tunde (tomato wholesaler)", stellar_address: TUNDE }]),
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
      const done: Action = { ...a, status: "done", result: { ok: true, sending: true, amount: a.params.amount, transaction_id: "t1", repay: extra.repay ?? 0 } };
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
    agentWallets: () => Promise.resolve([AGENT]),
    cashOuts: () => Promise.resolve([]),
    setCashOutCode: () => Promise.resolve(true),
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
    ...over,
  };
  const ctx = (args: Record<string, unknown> = {}, channel: "voice" | "app" = "voice"): NgContext => ({
    user: { id: "u1", market_id: "ng", name: "Funmi", language: "en", kyc_tier: 1, stellar_pub: FUNMI, auto_save_bps: 0, ref_hash: null, trusted_contact_phone: null },
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
  assertMatch(r.text, /check her screen and tap Yes/);
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

Deno.test("above ₦20,000 money leaving needs the PIN, typed on screen, never by voice", async () => {
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
