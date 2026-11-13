// Piece 13, item 10: "Reset for recording" on the staff /demo page. Puts Funmi (and what a
// recording touches around her) back to the demo start without the CLI: the same two halves as a
// guest reset (_shared/guests.ts).
//
//   recordingDbReset   instant, in the database: waiting actions and cash-ins of every Nigeria demo
//                      person expired; Funmi's unused cash-out codes returned (Mama Bisi claims the
//                      money back through the outbox); an open loan settled (closed_by_reset);
//                      borrowing open; stall stock verified; payees added in a recording (e.g.
//                      "Mama Ngozi") removed, keeping Iya Tunde and Landlord; shares revoked;
//                      Amaka's waiting vouch withdrawn (Tunde's stays); the 10-minute demo limit cleared.
//   recordingConverge  on Stellar, one step per call, through the chain outbox (never signed here):
//                      Funmi's queue clear, her savings pot back to ₦18,500, her wallet to ₦26,400,
//                      Mama Bisi's float to ₦200,000 (the guests' treasury pays or takes the
//                      difference), the savings ledger agreed. Then "ready".
// Every row's ref is rec:<generation>:<what>, so a repeated call never queues anything twice.
// Never deletes money history; it only adds transactions and moves statuses forward.
import type { SupabaseClient } from "@supabase/supabase-js";
import { contractReader, refreshBalances } from "./ng-chain.ts";
import { enqueue, GUEST, hiddenTx, ngnt, settleTo, systemPubs, TREASURY } from "./guests.ts";

type Db = SupabaseClient;
const N = 100n;
export const RECORDING = { wallet: 26_400n * N, savings: 18_500n * N, float: 200_000n * N } as const;
/** Payees Funmi starts with; anything else was added during a recording. */
export const KEEP_PAYEES = ["Iya Tunde (tomato wholesaler)", "Landlord"] as const;

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}
const stroops = (kobo: bigint) => (kobo * 100_000n).toString();

export type RecStep = { step: string; done: boolean; note?: string };

/** Funmi's row, found by her wallet key's Vault name (signer `funmi`). */
async function funmi(db: Db): Promise<{ id: string; pub: string }> {
  const u = must(await db.from("users").select("id, stellar_pub").eq("secret_name", "STELLAR_SECRET_FUNMI").is("archived_at", null).single(), "Funmi") as { id: string; stellar_pub: string };
  return { id: u.id, pub: u.stellar_pub };
}
/** Mama Bisi, the presenter agent (signer `agent_ng`). */
async function bisi(db: Db): Promise<{ id: string; pub: string } | null> {
  const h = must(await db.from("helpers").select("id, stellar_pub").eq("secret_name", "STELLAR_SECRET_AGENT_NG").maybeSingle(), "Mama Bisi") as { id: string; stellar_pub: string } | null;
  return h ? { id: h.id, pub: h.stellar_pub } : null;
}

/** The database half. Returns the generation (seconds) that names this reset's outbox rows. */
export async function recordingDbReset(db: Db, now = new Date()): Promise<number> {
  const iso = now.toISOString();
  const gen = Math.floor(now.getTime() / 1000);
  const f = await funmi(db);
  const demo = must(await db.from("users").select("id").eq("market_id", "ng").eq("demo_login", true).is("archived_at", null), "demo people") as { id: string }[];
  const ids = [...new Set([f.id, ...demo.map((d) => d.id)])];

  must(await db.from("pending_actions").update({ status: "expired", updated_at: iso }).in("user_id", ids).eq("status", "pending"), "expire actions");
  must(await db.from("cash_events").update({ status: "expired", updated_at: iso }).in("user_id", ids).eq("status", "awaiting_user"), "expire cash-ins");
  const agent = await bisi(db);
  if (agent) {
    const rows = must(await db.from("cash_events").update({ status: "expired", updated_at: iso }).eq("helper_id", agent.id).eq("status", "awaiting_user").select("pending_action_id"), "agent cash-ins") as { pending_action_id: string | null }[];
    const pa = rows.map((r) => r.pending_action_id).filter((x): x is string => Boolean(x));
    if (pa.length) must(await db.from("pending_actions").update({ status: "expired", updated_at: iso }).in("id", pa).eq("status", "pending"), "their actions");
  }

  // Unused cash-out codes: Mama Bisi claims the money back; the code is returned.
  const codes = must(await db.from("cash_out_codes").select("id, create_outbox_id").in("user_id", ids).eq("status", "issued"), "codes") as { id: string; create_outbox_id: number | null }[];
  for (const c of codes) {
    const out = c.create_outbox_id
      ? must(await db.from("chain_outbox").select("status, result").eq("id", c.create_outbox_id).maybeSingle(), "code row") as { status: string; result: { balance_id?: string } | null } | null
      : null;
    if (out?.status === "done" && out.result?.balance_id) {
      await enqueue(db, "agent_ng", "claimable_claim", `rec:${gen}:code:${c.id}`, { balance_id: out.result.balance_id });
    }
    must(await db.from("cash_out_codes").update({ status: "returned", updated_at: iso }).eq("id", c.id).eq("status", "issued"), "code returned");
  }

  // Loan settled by the reset (never counted as repaid by her); borrowing open.
  const open = must(await db.from("loans").update({ status: "repaid", closed_by_reset: true, repaid_at: iso, borrowing_paused: false })
    .eq("user_id", f.id).in("status", ["active", "late", "restructured"]).select("id"), "settle loans") as { id: string }[];
  for (const l of open) must(await db.from("loan_events").insert({ loan_id: l.id, user_id: f.id, kind: "reset", note: "settled by Reset for recording" }), "loan event");
  must(await db.from("users").update({ borrowing_frozen_until: null, vouch_banned_until: null, language: "en" }).eq("id", f.id), "borrowing open, English");

  // Stall stock verified (the offer's asset).
  const stock = must(await db.from("assets").select("id").eq("user_id", f.id).eq("description", GUEST.stock.description).limit(1).maybeSingle(), "stock") as { id: string } | null;
  if (stock) must(await db.from("assets").update(GUEST.stock).eq("id", stock.id), "stock");

  // Payees added during a recording go (Mama Ngozi and the like); the starting ones stay.
  const payees = must(await db.from("payees").select("id, name").eq("user_id", f.id), "payees") as { id: string; name: string }[];
  const extra = payees.filter((p) => !(KEEP_PAYEES as readonly string[]).includes(p.name)).map((p) => p.id);
  if (extra.length) must(await db.from("payees").delete().in("id", extra), "recording payees");

  must(await db.from("record_shares").update({ revoked_at: iso }).eq("user_id", f.id).is("revoked_at", null), "revoke shares");

  // Vouches: a demo person's waiting vouch (Amaka's, given live) is withdrawn; Tunde's stays.
  const forHer = must(await db.from("vouches").select("id, voucher_user_id").eq("borrower_user_id", f.id).eq("status", "active"), "vouches") as { id: string; voucher_user_id: string }[];
  for (const v of forHer.filter((x) => ids.includes(x.voucher_user_id))) await db.rpc("vouch_withdraw", { p_voucher: v.voucher_user_id, p_vouch_id: v.id });

  must(await db.from("demo_action_log").delete().in("actor_id", [...ids, ...(agent ? [agent.id] : [])]).gte("at", new Date(now.getTime() - 10 * 60_000).toISOString()), "demo limit");
  return gen;
}

/** The Stellar half, one step per call. */
export async function recordingConverge(db: Db, gen: number, env: { contractId: string }): Promise<RecStep> {
  const pubs = await systemPubs(db);
  const treasury = pubs[TREASURY];
  if (!treasury) return { step: "setup", done: false, note: "no guest_treasury wallet (pnpm guests:seed)" };
  const f = await funmi(db);
  const agent = await bisi(db);

  // Her queue (and Mama Bisi's) clear first: Stellar takes one transaction per account at a time.
  const busy = must(await db.from("chain_outbox").select("ref, status, attempts").in("signer", ["funmi", "agent_ng", TREASURY])
    .in("status", ["queued", "submitted"]).gte("created_at", new Date(Date.now() - 86_400_000).toISOString()).limit(20), "in flight") as { ref: string }[];
  if (busy.length) return { step: "wait", done: false, note: `${busy.length} on its way` };
  const { count: pendingIn } = await db.from("transactions").select("id", { count: "exact", head: true }).eq("user_id", f.id)
    .eq("status", "pending").gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
  if (pendingIn) return { step: "wait", done: false, note: `${pendingIn} of her transactions still pending` };

  // Savings pot back to ₦18,500.
  const goal = must(await db.from("savings_goals").select("id, onchain_pot_id").eq("user_id", f.id).eq("status", "active").maybeSingle(), "goal") as { id: string; onchain_pot_id: number | null } | null;
  if (goal?.onchain_pot_id != null) {
    const pot = await contractReader(env.contractId).pot(goal.onchain_pot_id);
    if (!pot) return { step: "savings", done: false, note: "pot not readable yet" };
    if (pot.balance_minor !== RECORDING.savings) {
      const diff = RECORDING.savings - pot.balance_minor;
      const ref = `rec:${gen}:pot:${diff}`;
      const txId = await hiddenTx(db, f.id, diff > 0n ? "saved" : "savings_out", -diff, ref);
      let after: number | null = null;
      if (diff > 0n && (await ngnt(f.pub)) < diff) {
        after = await enqueue(db, TREASURY, "payment", `rec:${gen}:prepot:${diff}`, { to: f.pub, asset: "NGNT", amount: stroops(diff), refresh_user_ids: [f.id] });
      }
      await enqueue(db, "funmi", "contract", ref, {
        fn: diff > 0n ? "pot_fund" : "pot_send",
        args: [{ t: "address", v: f.pub }, { t: "u32", v: goal.onchain_pot_id }, { t: "i128", v: stroops(diff > 0n ? diff : -diff) }],
        ...(txId ? { transaction_id: txId } : {}), refresh_user_ids: [f.id],
      }, after);
      return { step: "savings", done: false, note: "savings back to ₦18,500" };
    }
  }

  // Wallet ₦26,400; Mama Bisi's float ₦200,000.
  if (await settleTo(db, { pub: f.pub, signer: "funmi", target: RECORDING.wallet, ref: `rec:${gen}:wallet`, userId: f.id, treasury })) {
    return { step: "wallet", done: false, note: "wallet back to ₦26,400" };
  }
  if (agent && await settleTo(db, { pub: agent.pub, signer: "agent_ng", target: RECORDING.float, ref: `rec:${gen}:float`, treasury })) {
    return { step: "float", done: false, note: "Mama Bisi's float back to ₦200,000" };
  }

  // The savings ledger agrees with the pot.
  const { data: ledger } = await db.rpc("ng_savings_balance", { p_user_id: f.id });
  const drift = RECORDING.savings - BigInt(String(ledger ?? 0));
  if (drift !== 0n) {
    must(await db.from("transactions").insert({
      user_id: f.id, market_id: "ng", kind: "saved", source: "recording_reset_ledger", amount: (-drift).toString(), currency: "NGN", rail: "stellar",
      ref: `rec:${gen}:ledger`, status: "completed", hidden_from_history: true,
    }), "ledger");
  }
  await refreshBalances(db, [f.id]).catch(() => null);
  return { step: "done", done: true };
}
