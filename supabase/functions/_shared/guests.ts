// Piece 12: guest traders and guest agents for the public test link (one each per visitor).
//
// A guest trader is a real Plus user (signed up through the real sign-up on a test number, wallet
// key in Vault) with Funmi's whole story: 8 weeks of history, an ajo with members, a savings goal
// with auto-save, verified stall stock, one vouch, a ₦30,000 loan offer and saved payees.
//
// Reset (on reassignment after 30 idle minutes, and nightly) has two halves:
//   guestDbReset   instant, in the database: waiting actions expired, codes returned, loan settled
//                  (closed_by_reset), assets, payees, PIN 1234, shares revoked, history re-dated,
//                  settings, the compressed history, the rate-limit log.
//   guestConverge  on Stellar, one step per call, through the chain outbox (never signed here):
//                  waits until the guest's own queue is clear (the piece 11 lesson), then the savings
//                  pot, the first-time history, the pot balance, the wallet balance, a fresh ajo
//                  round with the other members paid in, and the vouch. Each step enqueues and
//                  returns; the next call (scheduler/guests every minute, or a loop) moves on.
// Every reset row's ref names the guest and the reset (guest<slot>:<generation>:<what>), so a call
// repeated during the same reset never queues anything twice.
//
// The treasury (guest_treasury, a Vault-held system wallet the issuer funds by script) pays every
// top-up and takes back every surplus, so NGNT only circulates. Nothing here touches the presenter
// accounts (Funmi, Kemi, Amaka, Mama Bisi); the shared demo agent is its own wallet.
import type { SupabaseClient } from "@supabase/supabase-js";
import { contractReader, horizonBalances, refreshBalances } from "./ng-chain.ts";
import { setPin } from "./pin.ts";
export { GUEST_LOCK_MS } from "./pin.ts";

export const GUEST_NAMES = [
  "Adaeze", "Bola", "Chiamaka", "Hauwa", "Ngozi", "Yetunde", "Amina", "Folake", "Ifeoma", "Zainab",
  "Kehinde", "Blessing", "Titi", "Nneka", "Halima", "Sade", "Ebere", "Rukayat", "Uche", "Mojisola",
  "Aisha", "Funke", "Jumoke", "Lami", "Omolara", "Patience", "Remi", "Shade", "Temitope", "Yemisi",
] as const;
export const guestName = (slot: number) => GUEST_NAMES[(slot - 1) % GUEST_NAMES.length];
/** Test numbers (codes show on screen): traders +2347000000601.., agents +2347000000680.. */
export const guestPhone = (slot: number) => `+2347000000${600 + slot}`;
export const guestAgentPhone = (slot: number) => `+2347000000${680 + slot}`;
export const GUEST_PIN = "1234";

const N = 100n; // kobo per naira
export const GUEST = {
  wallet: 26_400n * N,
  savings: 18_500n * N,
  goal: 50_000n * N,
  goalName: "Stall shade",
  autoSaveBps: 1000,
  ajoAmount: 2_000n * N,
  ajoPeriodSecs: 7 * 86_400,
  weeks: 8,
  stock: { type: "stock", description: "Stall stock (tomatoes)", estimated_value: "9000000", level: "independently_verified", status: "active", confidence: 85 },
  agentFloat: 200_000n * N, // a guest agent's float
  sharedFloat: 500_000n * N, // the shared demo agent (pretend cash-ins and pay-outs for every guest)
  memberMin: 10_000n * N, // an ajo member keeps at least this
  lendingMin: 1_000_000n * N,
} as const;

/** The other members of every guest's ajo (system wallets in Vault, users without a login). */
export const AJO_MEMBERS = [
  { signer: "ajo_m1", name: "Iya Sade", phone: "+2347000000691" },
  { signer: "ajo_m2", name: "Baba Femi", phone: "+2347000000692" },
  { signer: "ajo_m3", name: "Mama Ifeoma", phone: "+2347000000693" },
] as const;
export const SHOP = { signer: "guest_shop", name: "Mama Put Canteen", phone: "+2347000000690" } as const;
export const TREASURY = "guest_treasury";
export const agentSigner = (slot: number) => `guest_agent${slot}`;
export const SHARED_AGENT_NAME = "Mama Bisi";

type Db = SupabaseClient;
export type PoolRow = {
  kind: "trader" | "agent";
  slot: number;
  user_id: string | null;
  helper_id: string | null;
  used: boolean;
  last_seen_at: string | null;
  reset_requested_at: string | null;
  reset_started_at: string | null;
  reset_done_at: string | null;
  reset_step: string | null;
  history_seeded: boolean;
  ajo_create_outbox_id: number | null;
};

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}
const signerOf = (secretName: string | null | undefined) => /^STELLAR_SECRET_([A-Z][A-Z0-9_]{0,31})$/.exec(secretName ?? "")?.[1]?.toLowerCase() ?? null;
const stroops = (kobo: bigint) => (kobo * 100_000n).toString();
const gen = (row: PoolRow) => Math.floor(Date.parse(row.reset_started_at ?? row.reset_requested_at ?? new Date().toISOString()) / 1000);

/** Lagos time "d days ago at h o'clock" (for history rows' display dates; the chain time stays true). */
export function daysAgo(days: number, hour: number, now = Date.now()): string {
  const d = new Date(now - days * 86_400_000);
  d.setUTCHours(hour - 1, 10 + ((days * 7 + hour) % 40), 0, 0);
  return d.toISOString();
}

/** The history every guest starts with: real testnet movements, re-dated on each reset. */
export const HISTORY = [
  { key: "h1", kind: "incoming", source: "bank", counterparty: "Chidi Okeke", naira: 12_500n, from: TREASURY, days: 9, hour: 11 },
  { key: "h2", kind: "incoming", source: "cash", counterparty: SHARED_AGENT_NAME, naira: 8_000n, from: agentSigner(0), days: 6, hour: 17 },
  { key: "h3", kind: "pay", source: null, counterparty: "Iya Tunde (tomato wholesaler)", naira: 15_000n, to: "iya_tunde", days: 8, hour: 7 },
  { key: "h4", kind: "pay", source: "bank", counterparty: "Landlord", naira: 10_000n, to: "anchor_ng", days: 3, hour: 9 },
  { key: "h5", kind: "incoming", source: "bank", counterparty: "A customer", naira: 4_500n, from: TREASURY, days: 1, hour: 15 },
  { key: "s1", kind: "saved", source: "manual", counterparty: GUEST.goalName, naira: 10_000n, days: 9, hour: 18 },
  { key: "s2", kind: "saved", source: "auto_save", counterparty: GUEST.goalName, naira: 8_500n, days: 4, hour: 19 },
] as const;

export async function systemPubs(db: Db): Promise<Record<string, string>> {
  const rows = must(await db.from("system_wallets").select("signer, pub"), "system_wallets") as { signer: string; pub: string }[];
  return Object.fromEntries(rows.map((r) => [r.signer, r.pub]));
}

// ---------------------------------------------------------------------------------------------
// Database half (instant)
// ---------------------------------------------------------------------------------------------

type Guest = { id: string; stellar_pub: string | null; secret_name: string | null; name: string | null };

/** Waiting actions, codes, loan, assets, payees, PIN, shares, settings, history: back to the seed. */
export async function guestDbReset(db: Db, row: PoolRow, now = new Date()): Promise<void> {
  if (row.kind === "agent") return await agentDbReset(db, row, now);
  const id = row.user_id!;
  const iso = now.toISOString();
  const u = must(await db.from("users").select("id, stellar_pub, secret_name, name").eq("id", id).single(), "guest") as Guest;
  const pubs = await systemPubs(db);

  // 1. Anything waiting for her answer, and anything she asked of others.
  must(await db.from("pending_actions").update({ status: "expired", updated_at: iso }).eq("user_id", id).eq("status", "pending"), "expire actions");
  must(await db.from("cash_events").update({ status: "expired", updated_at: iso }).eq("user_id", id).eq("status", "awaiting_user"), "expire cash-ins");

  // 2. Unused cash-out codes: the shared demo agent claims the money back (its float is reset too).
  const codes = must(await db.from("cash_out_codes").select("id, create_outbox_id").eq("user_id", id).eq("status", "issued"), "codes") as { id: string; create_outbox_id: number | null }[];
  for (const c of codes) {
    const out = c.create_outbox_id
      ? must(await db.from("chain_outbox").select("status, result").eq("id", c.create_outbox_id).maybeSingle(), "code row") as { status: string; result: { balance_id?: string } | null } | null
      : null;
    if (out?.status === "done" && out.result?.balance_id) {
      must(await db.rpc("chain_enqueue_on", {
        p_signer: agentSigner(0), p_kind: "claimable_claim", p_ref: `guest${row.slot}:code:${c.id}`, p_args: { balance_id: out.result.balance_id },
      }), "claim code back");
    }
    must(await db.from("cash_out_codes").update({ status: "returned", updated_at: iso }).eq("id", c.id).eq("status", "issued"), "code returned");
  }

  // 3. Loan: settled by the reset (closed_by_reset: never counted as repaid by her); borrowing open.
  const open = must(await db.from("loans").update({ status: "repaid", closed_by_reset: true, repaid_at: iso, borrowing_paused: false })
    .eq("user_id", id).in("status", ["active", "late", "restructured"]).select("id"), "settle loans") as { id: string }[];
  for (const l of open) must(await db.from("loan_events").insert({ loan_id: l.id, user_id: id, kind: "reset", note: "settled by the guest reset" }), "loan event");

  // 4. Assets: her verified stall stock only; anything she added is released.
  const assets = must(await db.from("assets").select("id, description").eq("user_id", id).neq("status", "released"), "assets") as { id: string; description: string }[];
  const stock = assets.find((a) => a.description === GUEST.stock.description);
  const extra = assets.filter((a) => a !== stock).map((a) => a.id);
  if (extra.length) {
    must(await db.from("asset_witnesses").update({ status: "cancelled", answered_at: iso }).in("asset_id", extra).eq("status", "requested"), "cancel witnesses");
    must(await db.from("assets").update({ status: "released", confidence: 0 }).in("id", extra), "release assets");
  }
  if (stock) must(await db.from("assets").update(GUEST.stock).eq("id", stock.id), "stock");
  else {
    const old = must(await db.from("assets").select("id").eq("user_id", id).eq("description", GUEST.stock.description).limit(1).maybeSingle(), "old stock") as { id: string } | null;
    if (old) must(await db.from("assets").update(GUEST.stock).eq("id", old.id), "stock back");
    else must(await db.from("assets").insert({ user_id: id, ...GUEST.stock }), "stock");
  }
  // Requests other guests sent her as a witness.
  must(await db.from("asset_witnesses").update({ status: "cancelled", answered_at: iso }).eq("witness_user_id", id).eq("status", "requested"), "her witness requests");

  // 5. Saved payees: exactly the seeded four.
  must(await db.from("payees").delete().eq("user_id", id), "clear payees");
  const payees: Record<string, unknown>[] = [
    { user_id: id, name: "Landlord", bank_code: "D01", account_number: "0123456789", account_name: "ADEBAYO STORES" },
  ];
  if (pubs.iya_tunde) payees.push({ user_id: id, name: "Iya Tunde (tomato wholesaler)", stellar_address: pubs.iya_tunde });
  if (pubs[SHOP.signer]) payees.push({ user_id: id, name: SHOP.name, stellar_address: pubs[SHOP.signer] });
  if (pubs[AJO_MEMBERS[0].signer]) payees.push({ user_id: id, name: AJO_MEMBERS[0].name, stellar_address: pubs[AJO_MEMBERS[0].signer] });
  must(await db.from("payees").insert(payees), "payees");

  // 6. PIN 1234, no lockout. 7. Shares revoked. 8. Vouches she gave, withdrawn.
  await setPin(db, id, GUEST_PIN);
  must(await db.from("record_shares").update({ revoked_at: iso }).eq("user_id", id).is("revoked_at", null), "revoke shares");
  const given = must(await db.from("vouches").select("id").eq("voucher_user_id", id).eq("status", "active"), "her vouches") as { id: string }[];
  for (const v of given) await db.rpc("vouch_withdraw", { p_voucher: id, p_vouch_id: v.id });

  // 9. Her settings and her 8 weeks with Plus.
  must(await db.from("users").update({
    name: guestName(row.slot), language: "en", auto_save_bps: GUEST.autoSaveBps, kyc_tier: 2,
    member_since: new Date(now.getTime() - GUEST.weeks * 7 * 86_400_000 - 3 * 86_400_000).toISOString(),
    borrowing_frozen_until: null, vouch_banned_until: null,
  }).eq("id", id), "settings");
  const goal = must(await db.from("savings_goals").select("id").eq("user_id", id).eq("status", "active").maybeSingle(), "goal") as { id: string } | null;
  if (goal) must(await db.from("savings_goals").update({ name: GUEST.goalName, goal: GUEST.goal.toString(), updated_at: iso }).eq("id", goal.id), "goal");

  // 10. Compressed history (what the loan offer reads), topped up over her real activity.
  await seedCreditHistory(db, id, now);

  // 11. Her lists: only the seeded history shows, re-dated to the last ten days.
  must(await db.from("transactions").update({ hidden_from_history: true }).eq("user_id", id).eq("hidden_from_history", false), "hide rows");
  for (const h of HISTORY) {
    must(await db.from("transactions").update({ hidden_from_history: false, created_at: daysAgo(h.days, h.hour, now.getTime()) })
      .eq("user_id", id).eq("rail", "stellar").eq("ref", `guest_history:${row.slot}:${h.key}`), "re-date history");
  }

  // 12. The money-action limit starts again.
  must(await db.from("demo_action_log").delete().eq("actor_id", id), "rate log");

  must(await db.from("guest_pool").update({
    used: false, reset_requested_at: iso, reset_started_at: iso, reset_step: "chain", reset_error: null,
  }).eq("kind", row.kind).eq("slot", row.slot), "pool");
}

async function agentDbReset(db: Db, row: PoolRow, now: Date) {
  const iso = now.toISOString();
  const id = row.helper_id!;
  const rows = must(await db.from("cash_events").update({ status: "expired", updated_at: iso }).eq("helper_id", id).eq("status", "awaiting_user").select("pending_action_id"), "agent cash-ins") as { pending_action_id: string | null }[];
  const ids = rows.map((r) => r.pending_action_id).filter((x): x is string => Boolean(x));
  if (ids.length) must(await db.from("pending_actions").update({ status: "expired", updated_at: iso }).in("id", ids).eq("status", "pending"), "their actions");
  must(await db.from("asset_witnesses").update({ status: "cancelled", answered_at: iso }).eq("witness_helper_id", id).eq("status", "requested"), "agent requests");
  must(await db.from("demo_action_log").delete().eq("actor_id", id), "rate log");
  must(await db.from("guest_pool").update({ used: false, reset_requested_at: iso, reset_started_at: iso, reset_step: "chain", reset_error: null })
    .eq("kind", row.kind).eq("slot", row.slot), "pool");
}

/** Funmi's numbers: about ₦12,500 in a week, ajo every week, savings in the recent weeks. */
async function seedCreditHistory(db: Db, userId: string, now: Date) {
  must(await db.from("credit_history_seed").delete().eq("user_id", userId), "clear seed");
  const weeks = GUEST.weeks + 1;
  const real = must(await db.rpc("ng_credit_weeks", { p_user_id: userId }), "credit weeks") as
    { week: number; money_in: number; qualifying_tx: number; saved: number; savings: number }[];
  const byWeek = new Map(real.map((w) => [w.week, w]));
  const gap = (want: bigint, have: number | undefined) => (want > BigInt(have ?? 0) ? want - BigInt(have ?? 0) : 0n);
  const rows = Array.from({ length: weeks }, (_, i) => {
    const week = i + 1;
    const r = byWeek.get(week);
    const recent = weeks - i <= 8 && (weeks - i) % 4 !== 3;
    return {
      user_id: userId, week_index: week,
      money_in: gap(12_500n * N, r?.money_in).toString(),
      qualifying_tx: Math.max(0, 6 - (r?.qualifying_tx ?? 0)),
      saved: gap(1_000n * N, r?.saved).toString(),
      savings: gap(recent ? 500n * N : 0n, r?.savings).toString(),
    };
  }).filter((r) => r.money_in !== "0" || r.qualifying_tx > 0 || r.saved !== "0" || r.savings !== "0");
  void now;
  if (rows.length) must(await db.from("credit_history_seed").insert(rows), "seed history");
}

// ---------------------------------------------------------------------------------------------
// Stellar half (one step per call)
// ---------------------------------------------------------------------------------------------

export type Step = { step: string; done: boolean; note?: string };

async function enqueue(db: Db, signer: string, kind: string, ref: string, args: Record<string, unknown>, after: number | null = null): Promise<number> {
  return must(await db.rpc("chain_enqueue_on", { p_signer: signer, p_kind: kind, p_ref: ref, p_args: args, p_after: after }), `enqueue ${ref}`) as number;
}

/** Rows of this guest's reset (or on her own account) still on their way. */
async function inFlight(db: Db, slot: number, signer: string | null): Promise<{ busy: number; stuck: string | null }> {
  const filter = signer ? `signer.eq.${signer},ref.like.guest${slot}:%` : `ref.like.guest${slot}:%`;
  const rows = must(await db.from("chain_outbox").select("ref, status, attempts").or(filter).in("status", ["queued", "submitted", "failed"])
    .gte("created_at", new Date(Date.now() - 2 * 86_400_000).toISOString()).limit(50), "in flight") as { ref: string; status: string; attempts: number }[];
  const stuck = rows.find((r) => r.status === "failed" && r.attempts >= 8);
  return { busy: rows.filter((r) => r.status !== "failed" || r.attempts < 8).length, stuck: stuck?.ref ?? null };
}

async function hiddenTx(db: Db, userId: string, kind: string, kobo: bigint, ref: string): Promise<string | null> {
  const r = must(await db.from("transactions").upsert({
    user_id: userId, market_id: "ng", kind, source: "guest_reset", amount: kobo.toString(), currency: "NGN", rail: "stellar", ref,
    status: "pending", hidden_from_history: true,
  }, { onConflict: "rail,ref", ignoreDuplicates: true }).select("id"), "reset row") as { id: string }[];
  return r[0]?.id ?? null;
}

async function ngnt(pub: string): Promise<bigint> {
  return (await horizonBalances(pub)).balances.NGNT ?? 0n;
}

/** Move a wallet to exactly `target` kobo: a top-up from the treasury, or the surplus back to it. */
async function settleTo(db: Db, o: { pub: string; signer: string; target: bigint; ref: string; userId?: string; treasury: string }): Promise<boolean> {
  const have = await ngnt(o.pub);
  if (have === o.target) return false;
  const diff = o.target - have;
  const ref = `${o.ref}:${diff}`; // a later, different correction in the same reset gets its own row
  const txId = o.userId ? await hiddenTx(db, o.userId, "adjustment", diff, ref) : null;
  const common = { asset: "NGNT", ...(txId ? { transaction_id: txId } : {}), ...(o.userId ? { refresh_user_ids: [o.userId] } : {}) };
  if (diff > 0n) await enqueue(db, TREASURY, "payment", ref, { ...common, to: o.pub, amount: stroops(diff) });
  else await enqueue(db, o.signer, "payment", ref, { ...common, to: o.treasury, amount: stroops(-diff) });
  return true;
}

export async function guestConverge(db: Db, row: PoolRow, env: { contractId: string; ngntSac: string }): Promise<Step> {
  const g = gen(row);
  const pubs = await systemPubs(db);
  const treasury = pubs[TREASURY];
  if (!treasury) return { step: "setup", done: false, note: "no guest_treasury wallet (pnpm guests:seed)" };

  if (row.kind === "agent") {
    const h = must(await db.from("helpers").select("stellar_pub, secret_name").eq("id", row.helper_id!).single(), "agent") as { stellar_pub: string | null; secret_name: string | null };
    const signer = signerOf(h.secret_name);
    if (!h.stellar_pub || !signer) return { step: "wallet", done: false, note: "no wallet yet" };
    const q = await inFlight(db, row.slot + 100, signer);
    if (q.busy) return { step: "wait", done: false, note: `${q.busy} on its way` };
    if (await settleTo(db, { pub: h.stellar_pub, signer, target: row.slot === 0 ? GUEST.sharedFloat : GUEST.agentFloat, ref: `guest${row.slot + 100}:${g}:float`, treasury })) {
      return { step: "float", done: false };
    }
    return { step: "done", done: true };
  }

  const userId = row.user_id!;
  const u = must(await db.from("users").select("id, stellar_pub, secret_name, name").eq("id", userId).single(), "guest") as Guest;
  const signer = signerOf(u.secret_name);
  if (!u.stellar_pub || !signer) return { step: "wallet", done: false, note: "wallet not open yet" };
  const pub = u.stellar_pub;

  // 0. Her own queue clear first (Stellar takes one transaction per account at a time), and
  //    nothing of hers still on its way in.
  const q = await inFlight(db, row.slot, signer);
  if (q.stuck) return { step: "stuck", done: false, note: `a transaction failed for good: ${q.stuck}` };
  if (q.busy) return { step: "wait", done: false, note: `${q.busy} on its way` };
  const { count: pendingIn } = await db.from("transactions").select("id", { count: "exact", head: true }).eq("user_id", userId)
    .eq("status", "pending").gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
  if (pendingIn) return { step: "wait", done: false, note: `${pendingIn} of her transactions still pending` };

  // 1. Her savings pot on Stellar.
  let goal = must(await db.from("savings_goals").select("id, onchain_pot_id").eq("user_id", userId).eq("status", "active").maybeSingle(), "goal") as { id: string; onchain_pot_id: number | null } | null;
  if (!goal) {
    must(await db.rpc("ng_savings_goal_set", { p_user_id: userId, p_name: GUEST.goalName, p_goal: Number(GUEST.goal), p_asset_sac: env.ngntSac }), "goal set");
    return { step: "pot", done: false, note: "creating her savings pot" };
  }
  if (goal.onchain_pot_id === null) return { step: "pot", done: false, note: "waiting for the pot id" };

  // 2. First time only: her history, as real testnet movements (re-dated on every reset).
  if (!row.history_seeded) {
    await seedChainHistory(db, row.slot, userId, pub, signer, pubs, goal.onchain_pot_id);
    must(await db.from("guest_pool").update({ history_seeded: true }).eq("kind", "trader").eq("slot", row.slot), "seeded");
    return { step: "history", done: false };
  }

  // 3. Savings pot back to ₦18,500 (and the ledger with it).
  const chain = contractReader(env.contractId);
  const pot = await chain.pot(goal.onchain_pot_id);
  if (!pot) return { step: "pot", done: false, note: "pot not readable yet" };
  if (pot.balance_minor !== GUEST.savings) {
    const diff = GUEST.savings - pot.balance_minor;
    const ref = `guest${row.slot}:${g}:pot:${diff}`;
    const txId = await hiddenTx(db, userId, diff > 0n ? "saved" : "savings_out", -diff, ref);
    let after: number | null = null;
    if (diff > 0n && (await ngnt(pub)) < diff) {
      after = await enqueue(db, TREASURY, "payment", `guest${row.slot}:${g}:prepot:${diff}`, { to: pub, asset: "NGNT", amount: stroops(diff), refresh_user_ids: [userId] });
    }
    await enqueue(db, signer, "contract", ref, {
      fn: diff > 0n ? "pot_fund" : "pot_send",
      args: [{ t: "address", v: pub }, { t: "u32", v: goal.onchain_pot_id }, { t: "i128", v: stroops(diff > 0n ? diff : -diff) }],
      ...(txId ? { transaction_id: txId } : {}), refresh_user_ids: [userId],
    }, after);
    return { step: "savings", done: false };
  }

  // 4. Wallet back to ₦26,400.
  if (await settleTo(db, { pub, signer, target: GUEST.wallet, ref: `guest${row.slot}:${g}:wallet`, userId, treasury })) return { step: "wallet", done: false };

  // 5. Ajo: a fresh round where everyone but her has paid.
  const ajo = await ajoStep(db, row, g, u, pubs, chain, env.ngntSac);
  if (ajo) return ajo;

  // 6. One vouch (Iya Sade), once her ajo payments are on record.
  const m1 = must(await db.from("users").select("id").eq("stellar_pub", pubs[AJO_MEMBERS[0].signer] ?? "-").maybeSingle(), "m1") as { id: string } | null;
  if (m1) {
    const { data: c } = await db.rpc("vouch_check", { p_voucher: m1.id, p_borrower: userId });
    const check = c as { ok: boolean; reason?: string } | null;
    if (check?.ok) must(await db.rpc("vouch_record", { p_voucher: m1.id, p_borrower: userId }), "vouch");
    else if (check?.reason === "no_ajo_payments" && Date.now() / 1000 - g < 15 * 60) return { step: "vouch", done: false, note: "waiting for the ajo payments to sync" };
  }

  // 7. The savings ledger agrees with the pot; balances fresh; done.
  const { data: ledger } = await db.rpc("ng_savings_balance", { p_user_id: userId });
  const drift = GUEST.savings - BigInt(String(ledger ?? 0));
  if (drift !== 0n) {
    must(await db.from("transactions").insert({
      user_id: userId, market_id: "ng", kind: "saved", source: "guest_reset_ledger", amount: (-drift).toString(), currency: "NGN", rail: "stellar",
      ref: `guest${row.slot}:${g}:ledger`, status: "completed", hidden_from_history: true,
    }), "ledger");
  }
  await refreshBalances(db, [userId]).catch(() => null);
  return { step: "done", done: true };
}

/** Seven real movements (and a funding top-up) that make up her last ten days, chained in order. */
async function seedChainHistory(db: Db, slot: number, userId: string, pub: string, signer: string, pubs: Record<string, string>, potId: number) {
  const now = Date.now();
  const total = GUEST.wallet + GUEST.savings; // the history nets to zero, then ₦18,500 goes into the pot
  const fundId = await hiddenTx(db, userId, "adjustment", total, `guest_history:${slot}:fund`);
  const fund = await enqueue(db, TREASURY, "payment", `guest${slot}:hist:fund`, { to: pub, asset: "NGNT", amount: stroops(total), ...(fundId ? { transaction_id: fundId } : {}), refresh_user_ids: [userId] });
  let lastOwn: number | null = fund;
  for (const h of HISTORY) {
    const amount = h.naira * N;
    const signed = h.kind === "incoming" ? -1n : 1n; // outgoing rows are negative
    const t = must(await db.from("transactions").upsert({
      user_id: userId, market_id: "ng", kind: h.kind, source: h.source, counterparty: h.counterparty, amount: (-signed * amount).toString(),
      currency: "NGN", rail: "stellar", ref: `guest_history:${slot}:${h.key}`, status: "pending", created_at: daysAgo(h.days, h.hour, now),
    }, { onConflict: "rail,ref", ignoreDuplicates: true }).select("id"), "history row") as { id: string }[];
    const txId = t[0]?.id;
    const extra = { ...(txId ? { transaction_id: txId } : {}), refresh_user_ids: [userId] };
    if (h.kind === "incoming") {
      await enqueue(db, "from" in h ? h.from : TREASURY, "payment", `guest${slot}:hist:${h.key}`, { to: pub, asset: "NGNT", amount: stroops(amount), ...extra });
    } else if (h.kind === "pay") {
      const to = pubs["to" in h ? h.to : ""] ?? pubs[TREASURY];
      lastOwn = await enqueue(db, signer, "payment", `guest${slot}:hist:${h.key}`, { to, asset: "NGNT", amount: stroops(amount), ...extra }, lastOwn);
    } else {
      lastOwn = await enqueue(db, signer, "contract", `guest${slot}:hist:${h.key}`, {
        fn: "pot_fund", args: [{ t: "address", v: pub }, { t: "u32", v: potId }, { t: "i128", v: stroops(amount) }], ...extra,
      }, lastOwn);
    }
  }
}

type Reader = ReturnType<typeof contractReader>;

async function ajoStep(db: Db, row: PoolRow, g: number, u: Guest, pubs: Record<string, string>, chain: Reader, ngntSac: string): Promise<Step | null> {
  const members = AJO_MEMBERS.map((m) => ({ ...m, pub: pubs[m.signer] }));
  if (members.some((m) => !m.pub)) return { step: "ajo", done: false, note: "ajo member wallets missing (pnpm guests:seed)" };
  const order = [members[0].pub, members[1].pub, u.stellar_pub!, members[2].pub];
  const names = [members[0].name, members[1].name, u.name ?? guestName(row.slot), members[2].name];

  // A round being created: mirror it once Stellar has its id.
  if (row.ajo_create_outbox_id) {
    const out = must(await db.from("chain_outbox").select("status, attempts, result").eq("id", row.ajo_create_outbox_id).single(), "ajo create") as { status: string; attempts: number; result: { returned?: string | number } | null };
    if (out.status !== "done") return out.status === "failed" && out.attempts >= 8 ? { step: "stuck", done: false, note: "group_create failed" } : { step: "ajo", done: false, note: "creating the round" };
    const onchain = Number(out.result?.returned);
    if (!Number.isInteger(onchain)) return { step: "ajo", done: false, note: "no group id in the result" };
    const fresh = await chain.group(onchain);
    if (!fresh) return { step: "ajo", done: false, note: "group not readable yet" };
    const grp = must(await db.from("groups").upsert({
      market_id: "ng", name: "Market Ajo", mode: "pooled", onchain_id: onchain, amount: GUEST.ajoAmount.toString(),
      period_secs: GUEST.ajoPeriodSecs, next_due: fresh.next_due.toISOString(),
    }, { onConflict: "onchain_id" }).select("id").single(), "group") as { id: string };
    const memberIds = must(await db.from("users").select("id, stellar_pub").in("stellar_pub", order), "member ids") as { id: string; stellar_pub: string }[];
    must(await db.from("group_members").upsert(order.map((p, position) => ({
      group_id: grp.id, position, member_ref: p, name: names[position], user_id: memberIds.find((m) => m.stellar_pub === p)?.id ?? null,
    })), { onConflict: "group_id,position" }), "members");
    must(await db.from("guest_pool").update({ ajo_create_outbox_id: null }).eq("kind", "trader").eq("slot", row.slot), "pool");
    return { step: "ajo", done: false, note: `round ${onchain} created` };
  }

  const links = must(await db.from("group_members").select("groups!inner(id, onchain_id, created_at, retired_at)").eq("user_id", u.id)
    .not("groups.onchain_id", "is", null), "her groups") as unknown as { groups: { id: string; onchain_id: number; created_at: string; retired_at: string | null } }[];
  const current = links.map((l) => l.groups).filter((x) => !x.retired_at).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const state = current ? await chain.group(current.onchain_id) : null;
  const mine = state ? state.members.indexOf(u.stellar_pub!) : -1;
  if (!current || !state || mine < 0 || state.contributed[mine] || state.next_due.getTime() < Date.now() + 86_400_000) {
    // No round yet, or she paid this one (or it is about to pay out): a new round, same members.
    if (current) must(await db.from("groups").update({ payout_once: true }).eq("id", current.id), "old round pays out once");
    const id = await enqueue(db, AJO_MEMBERS[0].signer, "contract", `guest${row.slot}:${g}:ajo_create:${current?.onchain_id ?? "first"}`, {
      fn: "group_create",
      args: [{ t: "address", v: members[0].pub }, { t: "accounts", v: order }, { t: "address", v: ngntSac }, { t: "i128", v: stroops(GUEST.ajoAmount) },
        { t: "u64", v: String(GUEST.ajoPeriodSecs) }, { t: "bool", v: true }],
    });
    must(await db.from("guest_pool").update({ ajo_create_outbox_id: id }).eq("kind", "trader").eq("slot", row.slot), "pool");
    return { step: "ajo", done: false, note: "new round" };
  }
  // Everyone but her pays in (each member's own queue; topped up from the treasury when short).
  let queued = 0;
  for (const [i, m] of members.entries()) {
    const idx = state.members.indexOf(m.pub);
    if (idx < 0 || state.contributed[idx]) continue;
    let after: number | null = null;
    const have = await ngnt(m.pub);
    if (have < GUEST.ajoAmount + GUEST.memberMin) {
      after = await enqueue(db, TREASURY, "payment", `guest${row.slot}:${g}:ajo_top:${current.onchain_id}:${i}`, { to: m.pub, asset: "NGNT", amount: stroops(GUEST.memberMin * 5n) });
    }
    await enqueue(db, m.signer, "contract", `guest${row.slot}:${g}:ajo_pay:${current.onchain_id}:${i}`, {
      fn: "group_contribute", args: [{ t: "address", v: m.pub }, { t: "u32", v: current.onchain_id }],
    }, after);
    queued++;
  }
  return queued ? { step: "ajo", done: false, note: `${queued} member payment(s)` } : null;
}

/** Start a reset now: the database half at once, the Stellar half by guestConverge. */
export async function startReset(db: Db, kind: "trader" | "agent", slot: number): Promise<PoolRow> {
  const row = must(await db.from("guest_pool").select("*").eq("kind", kind).eq("slot", slot).single(), "pool row") as PoolRow;
  await guestDbReset(db, row);
  return must(await db.from("guest_pool").select("*").eq("kind", kind).eq("slot", slot).single(), "pool row") as PoolRow;
}

/** Run guestConverge for a place and record where it stands. */
export async function convergeAndRecord(db: Db, row: PoolRow, env: { contractId: string; ngntSac: string }): Promise<Step> {
  let s: Step;
  try {
    s = await guestConverge(db, row, env);
  } catch (err) {
    s = { step: "error", done: false, note: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
  const patch: Record<string, unknown> = { reset_step: s.step, reset_error: s.step === "error" || s.step === "stuck" ? s.note ?? s.step : null };
  if (s.done) Object.assign(patch, { reset_done_at: new Date().toISOString(), reset_requested_at: null });
  await db.from("guest_pool").update(patch).eq("kind", row.kind).eq("slot", row.slot);
  return s;
}

/** Nightly housekeeping: the shop's takings back to the treasury, the lender's account topped up. */
export async function houseKeeping(db: Db): Promise<string[]> {
  const pubs = await systemPubs(db);
  const treasury = pubs[TREASURY];
  if (!treasury) return ["no treasury"];
  const day = new Date().toISOString().slice(0, 10);
  const done: string[] = [];
  if (pubs[SHOP.signer] && await settleTo(db, { pub: pubs[SHOP.signer], signer: SHOP.signer, target: 50_000n * N, ref: `guests:shop:${day}`, treasury })) done.push("shop settled");
  if (pubs.lending_ng && (await ngnt(pubs.lending_ng)) < GUEST.lendingMin) {
    await enqueue(db, TREASURY, "payment", `guests:lending:${day}`, { to: pubs.lending_ng, asset: "NGNT", amount: stroops(GUEST.lendingMin) });
    done.push("lending topped up");
  }
  return done;
}

/** The places whose reset is under way (started, not finished). */
export const inReset = (r: PoolRow) => Boolean(r.reset_started_at) && (!r.reset_done_at || r.reset_done_at < r.reset_started_at!);
