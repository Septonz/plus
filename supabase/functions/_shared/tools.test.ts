// Tests for the shared tools (voice and app): confirm idempotency, PIN lockout, the PIN
// threshold on the voice channel, payee matching, cash-in rejection and the helper allowance.
// The in-memory store follows the same state machine as execute_pending_action /
// reject_pending_action (supabase/tests/actions.test.sql tests the real SQL).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { cashInAllowance } from "./helper.ts";
import { matchPayee, parseMajorAmount } from "./payees.ts";
import { checkPin, newPinCredential, type PinCredential, type PinOutcome } from "./pin.ts";
import {
  type Account,
  type Action,
  type Channel,
  confirmAction,
  dayStart,
  preparePay,
  rejectAction,
  roundStart,
  setAutoSave,
  type Store,
  type Tool,
  type User,
  whatArrived,
} from "./tools.ts";

Deno.env.set("PIN_PEPPER", "test-pepper-0123456789abcdef0123456789abcdef");

const SELVI: User = {
  id: "00000000-0000-4000-8000-000000000001",
  market_id: "in",
  name: "Selvi",
  language: "ta",
  kyc_tier: 2, // the partner bank has done full KYC
  member_since: "2026-06-01T00:00:00Z",
  stellar_pub: null,
  auto_save_bps: 1000,
  ref_hash: "ab".repeat(32),
  trusted_contact_phone: null,
};

class FakeStore implements Store {
  acct: Account = { balance_paise: 235000, savings_paise: 141500, bank_name: "Partner Bank (simulated)" };
  actions = new Map<string, Action>();
  debits: { amount: bigint; ref: string }[] = [];
  credits: { amount: bigint; ref: string }[] = [];
  cred: PinCredential | null = null;
  executions = 0;
  paidToday = 0n;
  payeeList = [
    { id: "p1", name: "flower wholesaler", upi_handle: "madurai.flowers@upisim" },
    { id: "p2", name: "medical shop", upi_handle: "medical.shop@upisim" },
  ];
  now = new Date("2026-11-09T10:00:00Z");

  account() {
    return Promise.resolve(this.acct);
  }
  hasPin() {
    return Promise.resolve(this.cred !== null);
  }
  async verifyPin(_u: string, pin: string): Promise<PinOutcome> {
    if (!this.cred) return { ok: false, outcome: "not_set" };
    const { result, update } = await checkPin(this.cred, pin, this.now);
    if (update) this.cred = { ...this.cred, ...update };
    return result;
  }
  async setPin(_u: string, pin: string) {
    this.cred = { ...(await newPinCredential(pin)), failed_attempts: 0, locked_until: null };
  }
  payees() {
    return Promise.resolve(this.payeeList);
  }
  paidSince() {
    return Promise.resolve(this.paidToday);
  }
  createAction(a: { user_id: string; kind: string; params: Record<string, unknown>; readback: string; ttl_secs: number }) {
    const row: Action = {
      id: crypto.randomUUID(),
      user_id: a.user_id,
      kind: a.kind,
      params: a.params,
      readback: a.readback,
      status: "pending",
      result: null,
      expires_at: new Date(this.now.getTime() + a.ttl_secs * 1000).toISOString(),
      created_by: "user",
      created_at: this.now.toISOString(),
    };
    this.actions.set(row.id, row);
    return Promise.resolve(row);
  }
  addHelperCashIn(amount: number): Action {
    const row: Action = {
      id: crypto.randomUUID(),
      user_id: SELVI.id,
      kind: "confirm_cash_in",
      params: { amount: String(amount), cash_event_id: "ce1", helper_name: "Meena" },
      readback: "Meena says you gave her ₹500 in cash. Is that right?",
      status: "pending",
      result: null,
      expires_at: new Date(this.now.getTime() + 86_400_000).toISOString(),
      created_by: "helper",
      created_at: this.now.toISOString(),
    };
    this.actions.set(row.id, row);
    return row;
  }
  action(id: string, userId: string) {
    const a = this.actions.get(id);
    return Promise.resolve(a && a.user_id === userId ? { ...a } : null);
  }
  pendingActions() {
    return Promise.resolve([...this.actions.values()].filter((a) => a.status === "pending"));
  }
  // Same state machine as execute_pending_action: claim pending -> run once -> store result.
  executeAction(id: string, userId: string) {
    const a = this.actions.get(id);
    if (!a || a.user_id !== userId) throw new Error("action_not_found");
    if (a.status !== "pending") return Promise.resolve({ ...a });
    this.executions++;
    const amount = BigInt(String(a.params.amount ?? 0));
    if (a.kind === "pay" || a.kind === "group_contribution") {
      if (BigInt(this.acct.balance_paise) < amount) {
        Object.assign(a, { status: "failed", result: { ok: false, error: "insufficient_funds" } });
        return Promise.resolve({ ...a });
      }
      this.acct = { ...this.acct, balance_paise: Number(BigInt(this.acct.balance_paise) - amount) };
      this.debits.push({ amount, ref: `action:${a.id}` });
    } else if (a.kind === "confirm_cash_in") {
      this.credits.push({ amount, ref: String(a.params.cash_event_id) });
    }
    Object.assign(a, { status: "done", result: { ok: true, amount: String(amount), payee_name: a.params.payee_name } });
    return Promise.resolve({ ...a });
  }
  rejectAction(id: string, userId: string) {
    const a = this.actions.get(id);
    if (!a || a.user_id !== userId) throw new Error("action_not_found");
    if (a.status === "pending") Object.assign(a, { status: "rejected", result: { ok: true, rejected: true } });
    return Promise.resolve({ ...a });
  }
  incoming() {
    return Promise.resolve([
      { id: "t1", kind: "incoming", source: "state_transfer", amount: 100000, created_at: this.now.toISOString(), chain_tx_hash: null },
    ]);
  }
  transactions() {
    return Promise.resolve([]);
  }
  awaitingCashIns() {
    return Promise.resolve(
      [...this.actions.values()].filter((a) => a.kind === "confirm_cash_in" && a.status === "pending").map((a) => ({
        cash_event_id: String(a.params.cash_event_id),
        pending_action_id: a.id,
        amount: String(a.params.amount),
        helper_name: String(a.params.helper_name),
        created_at: a.created_at,
      })),
    );
  }
  myGroup() {
    return Promise.resolve(null);
  }
  lastContribution() {
    return Promise.resolve(null);
  }
  chainEventsForRef() {
    return Promise.resolve([]);
  }
  groupRecords() {
    return Promise.resolve([]);
  }
  chainPending() {
    return Promise.resolve(0);
  }
  updateUser() {
    return Promise.resolve();
  }
}

const run = (tool: Tool, store: FakeStore, args: Record<string, unknown>, channel: Channel = "voice") =>
  tool({ user: SELVI, store, args, channel, now: store.now });

// ---------------------------------------------------------------------------

Deno.test("prepare_pay: 'poo kadai' and 'flower shop' both mean the flower wholesaler", async () => {
  for (const said of ["poo kadai", "flower shop", "பூக்கடைக்கு", "Pookadai"]) {
    const s = new FakeStore();
    const r = await run(preparePay, s, { payee: said, amount: 300 });
    assert(r.ok, `${said}: ${r.text}`);
    assertEquals((r.payee as { name: string }).name, "flower wholesaler");
    assertEquals(r.readback, "₹300 to flower wholesaler");
    assertEquals(r.requires_pin, false);
    assert(String(r.text).includes("300 rupees"), r.text);
    assert(!/dollar|\$/i.test(String(r.text)), "India text must never mention dollars");
    assertEquals(s.debits.length, 0, "prepare must not move money");
  }
  const s = new FakeStore();
  const r = await run(preparePay, s, { payee: "medical kadai", amount: "150" });
  assertEquals((r.payee as { name: string }).name, "medical shop");
});

Deno.test("prepare_pay: an ambiguous payee returns the options instead of guessing", async () => {
  const s = new FakeStore();
  s.payeeList.push({ id: "p3", name: "medical lab", upi_handle: "lab@upisim" });
  const r = await run(preparePay, s, { payee: "medical", amount: 100 });
  assertEquals(r.ok, false);
  assertEquals(r.error, "ambiguous_payee");
  assertEquals((r.options as { name: string }[]).map((o) => o.name).sort(), ["medical lab", "medical shop"]);
  assertEquals(s.actions.size, 0, "no action is prepared when the payee is unclear");
  // and only filler words with several payees is ambiguous too
  assertEquals(matchPayee("kadai", s.payeeList).kind, "ambiguous");
  assertEquals(matchPayee("tailor", s.payeeList).kind, "none");
});

Deno.test("prepare_pay: refuses over the balance and over the daily cap", async () => {
  const s = new FakeStore();
  assertEquals((await run(preparePay, s, { payee: "flower", amount: 5000 })).error, "insufficient_funds");
  s.acct = { ...s.acct, balance_paise: 5_000_000 };
  s.paidToday = 950_000n; // ₹9,500 of ₹10,000 used today
  const r = await run(preparePay, s, { payee: "flower", amount: 600 });
  assertEquals(r.error, "daily_limit");
  assertEquals(r.left_today_text, "₹500");
});

Deno.test("confirm_action is idempotent: two confirms, one debit, same result", async () => {
  const s = new FakeStore();
  const p = await run(preparePay, s, { payee: "flower shop", amount: 300 });
  const first = await run(confirmAction, s, { action_id: p.action_id });
  const second = await run(confirmAction, s, { action_id: p.action_id });
  const third = await run(confirmAction, s, { action_id: p.action_id }, "app");
  assertEquals(first.status, "done");
  assertEquals(second.result, first.result);
  assertEquals(third.status, "done");
  assertEquals(s.debits.length, 1);
  assertEquals(s.executions, 1);
  assertEquals(s.acct.balance_paise, 235000 - 30000);
  assert(String(first.text).includes("300 rupees"), first.text);
});

Deno.test("PIN threshold: voice can't confirm above it, and never carries a PIN", async () => {
  const s = new FakeStore();
  s.acct = { ...s.acct, balance_paise: 1_000_000 };
  await s.setPin(SELVI.id, "2580");
  const p = await run(preparePay, s, { payee: "medical shop", amount: 600 }); // threshold ₹500
  assertEquals(p.requires_pin, true);
  assert(String(p.text).includes("PIN"), p.text);

  const byVoice = await run(confirmAction, s, { action_id: p.action_id });
  assertEquals(byVoice.error, "pin_required_on_screen");
  const pinByVoice = await run(confirmAction, s, { action_id: p.action_id, pin: "2580" });
  assertEquals(pinByVoice.error, "pin_not_allowed_by_voice");
  const noPin = await run(confirmAction, s, { action_id: p.action_id }, "app");
  assertEquals(noPin.error, "pin_required");
  assertEquals(s.debits.length, 0);

  const ok = await run(confirmAction, s, { action_id: p.action_id, pin: "2580" }, "app");
  assertEquals(ok.status, "done");
  assertEquals(s.debits.length, 1);

  // At or below the threshold the voice agent may confirm after a clear yes.
  const small = await run(preparePay, s, { payee: "medical shop", amount: 500 });
  assertEquals(small.requires_pin, false);
  assertEquals((await run(confirmAction, s, { action_id: small.action_id })).status, "done");
});

Deno.test("PIN lockout: 3 wrong PINs lock for 15 minutes, even the right PIN is refused", async () => {
  const s = new FakeStore();
  s.acct = { ...s.acct, balance_paise: 1_000_000 };
  await s.setPin(SELVI.id, "2580");
  const p = await run(preparePay, s, { payee: "medical shop", amount: 3000 });
  assertEquals((await run(confirmAction, s, { action_id: p.action_id, pin: "1111" }, "app")).attempts_left, 2);
  assertEquals((await run(confirmAction, s, { action_id: p.action_id, pin: "1112" }, "app")).attempts_left, 1);
  assertEquals((await run(confirmAction, s, { action_id: p.action_id, pin: "1113" }, "app")).error, "pin_locked");
  const right = await run(confirmAction, s, { action_id: p.action_id, pin: "2580" }, "app");
  assertEquals(right.error, "pin_locked");
  assertEquals(s.debits.length, 0);
  // the PIN never appears in any reply
  assert(!JSON.stringify(right).includes("2580"));

  s.now = new Date(s.now.getTime() + 15 * 60_000 + 1);
  assertEquals((await run(confirmAction, s, { action_id: p.action_id, pin: "2580" }, "app")).status, "done");
});

Deno.test("cash-in: what_arrived asks about it first; No rejects it and nothing is credited", async () => {
  const s = new FakeStore();
  const ci = s.addHelperCashIn(50000);
  const w = await run(whatArrived, s, {});
  assert(String(w.text).startsWith("Meena says she gave 500 rupees in cash"), w.text);

  const no = await run(rejectAction, s, { action_id: ci.id });
  assertEquals(no.status, "rejected");
  assert(String(no.text).includes("not received"), no.text);
  // a later Yes changes nothing
  const yes = await run(confirmAction, s, { action_id: ci.id });
  assertEquals(yes.status, "rejected");
  assertEquals(s.credits.length, 0);
});

Deno.test("cash-in: her Yes by voice credits it (no PIN for money coming in)", async () => {
  const s = new FakeStore();
  const ci = s.addHelperCashIn(50000);
  const yes = await run(confirmAction, s, { action_id: ci.id });
  assertEquals(yes.status, "done");
  assertEquals(s.credits, [{ amount: 50000n, ref: "ce1" }]);
});

Deno.test("set_auto_save: 0 to 30 percent, read back before saving", async () => {
  const s = new FakeStore();
  assertEquals((await run(setAutoSave, s, { percent: 31 })).error, "invalid_percent");
  assertEquals((await run(setAutoSave, s, { percent: 12.5 })).error, "invalid_percent");
  const r = await run(setAutoSave, s, { percent: "15%" });
  assert(r.ok);
  assertEquals(r.kind, "set_auto_save");
  assert(String(r.text).includes("15 percent"), r.text);
  assertEquals(s.actions.get(String(r.action_id))!.params.bps, 1500);
});

Deno.test("helper allowance: daily limit", () => {
  assertEquals(cashInAllowance(1_500_000n, 2_000_000n, 500_000n), { ok: true, leftAfter: 0n });
  assertEquals(cashInAllowance(1_500_000n, 2_000_000n, 500_100n), { ok: false, left: 500_000n });
  assertEquals(cashInAllowance(0n, 2_000_000n, 0n), { ok: false, left: 2_000_000n });
});

Deno.test("amounts: integers only, rupees to paise", () => {
  assertEquals(parseMajorAmount(300), 30000n);
  assertEquals(parseMajorAmount("₹1,500"), 150000n);
  assertEquals(parseMajorAmount("300.5"), 30050n);
  assertEquals(parseMajorAmount("300 rupees"), 30000n);
  assertEquals(parseMajorAmount("-5"), null);
  assertEquals(parseMajorAmount("0"), null);
  assertEquals(parseMajorAmount("1e3"), null);
});

Deno.test("dayStart: India's day starts at 18:30 UTC", () => {
  assertEquals(dayStart("in", new Date("2026-11-09T10:00:00Z")), "2026-11-08T18:30:00.000Z");
  assertEquals(dayStart("in", new Date("2026-11-09T19:00:00Z")), "2026-11-09T18:30:00.000Z");
});

Deno.test("roundStart: a hand-started round hides earlier contributions; otherwise one period back", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  const month = 30 * 86_400;
  assertEquals(roundStart({ period_secs: month, round_started_at: null }, now), "2026-10-11T12:00:00.000Z");
  assertEquals(roundStart({ period_secs: month, round_started_at: "2026-11-10T09:00:00Z" }, now), "2026-11-10T09:00:00.000Z");
  // A marker older than one period changes nothing.
  assertEquals(roundStart({ period_secs: month, round_started_at: "2026-09-01T00:00:00Z" }, now), "2026-10-11T12:00:00.000Z");
});
