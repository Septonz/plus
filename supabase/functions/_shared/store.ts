// Store backed by Postgres through the service-role client. Money changes only through the
// database functions (execute_pending_action, reject_pending_action), never direct updates.
import type { SupabaseClient } from "@supabase/supabase-js";
import { setPin as setPinRow, verifyPin as verifyPinRow } from "./pin.ts";
import type { Action, ChainEvent, Store, Tx } from "./tools.ts";

const TX_COLS = "id, kind, source, amount, created_at, chain_tx_hash";
const ACTION_COLS = "id, user_id, kind, params, readback, status, result, expires_at, created_by, created_at";
const REF_EVENT_TYPES = ["attested", "contribution_recorded", "limit_set", "advance_recorded", "repayment_recorded"];

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

export function supabaseStore(db: SupabaseClient): Store {
  return {
    async account(userId) {
      return must(
        await db.from("sim_bank_accounts").select("balance_paise, savings_paise, bank_name").eq("user_id", userId).maybeSingle(),
        "account",
      );
    },
    async hasPin(userId) {
      const { count, error } = await db.from("user_credentials").select("user_id", { count: "exact", head: true }).eq("user_id", userId);
      if (error) throw new Error(`hasPin: ${error.message}`);
      return (count ?? 0) > 0;
    },
    verifyPin: (userId, pin) => verifyPinRow(db, userId, pin),
    setPin: (userId, pin) => setPinRow(db, userId, pin),
    async payees(userId) {
      return must(await db.from("payees").select("id, name, upi_handle").eq("user_id", userId).order("name"), "payees");
    },
    async paidSince(userId, sinceIso) {
      const rows = must(
        await db.from("transactions").select("amount").eq("user_id", userId).in("kind", ["pay", "group_contribution"])
          .gte("created_at", sinceIso),
        "paidSince",
      ) as { amount: number | string }[];
      return rows.reduce((s, r) => s - BigInt(r.amount), 0n);
    },
    async createAction(a) {
      return must(
        await db.from("pending_actions").insert({
          user_id: a.user_id,
          kind: a.kind,
          params: a.params,
          readback: a.readback,
          expires_at: new Date(Date.now() + a.ttl_secs * 1000).toISOString(),
        }).select(ACTION_COLS).single(),
        "createAction",
      ) as Action;
    },
    async action(id, userId) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      return must(await db.from("pending_actions").select(ACTION_COLS).eq("id", id).eq("user_id", userId).maybeSingle(), "action") as
        | Action
        | null;
    },
    async pendingActions(userId) {
      return must(
        await db.from("pending_actions").select(ACTION_COLS).eq("user_id", userId).eq("status", "pending")
          .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(5),
        "pendingActions",
      ) as Action[];
    },
    async executeAction(id, userId) {
      return must(await db.rpc("execute_pending_action", { p_action_id: id, p_user_id: userId }), "execute_pending_action") as Action;
    },
    async rejectAction(id, userId) {
      return must(await db.rpc("reject_pending_action", { p_action_id: id, p_user_id: userId }), "reject_pending_action") as Action;
    },
    async incoming(userId, sinceIso, limit) {
      return must(
        await db.from("transactions").select(TX_COLS).eq("user_id", userId).eq("kind", "incoming").eq("status", "completed")
          .gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(limit),
        "incoming",
      ) as Tx[];
    },
    async transactions(userId, limit) {
      return must(
        await db.from("transactions").select(TX_COLS).eq("user_id", userId).order("created_at", { ascending: false }).limit(limit),
        "transactions",
      ) as Tx[];
    },
    async awaitingCashIns(userId) {
      const rows = must(
        await db.from("cash_events").select("id, amount, created_at, pending_action_id, helpers(name)").eq("user_id", userId)
          .eq("direction", "in").eq("status", "awaiting_user").order("created_at", { ascending: false }).limit(5),
        "awaitingCashIns",
      ) as unknown as { id: string; amount: number; created_at: string; pending_action_id: string | null; helpers: { name: string } | null }[];
      return rows.map((r) => ({
        cash_event_id: r.id,
        pending_action_id: r.pending_action_id,
        amount: r.amount,
        helper_name: r.helpers?.name ?? "A helper",
        created_at: r.created_at,
      }));
    },
    async myGroup(userId) {
      const link = must(
        await db.from("group_members").select("group_id, groups!inner(id, name, mode, onchain_id, amount, period_secs, next_due, market_id, round_started_at)")
          .eq("user_id", userId).limit(1).maybeSingle(),
        "myGroup",
      ) as { group_id: string; groups: Record<string, unknown> } | null;
      if (!link) return null;
      const members = must(
        await db.from("group_members").select("name, position, member_ref, user_id").eq("group_id", link.group_id).order("position"),
        "members",
      );
      return { group: link.groups as never, members: members as never };
    },
    async lastContribution(userId, groupId, sinceIso) {
      return must(
        await db.from("transactions").select(TX_COLS).eq("user_id", userId).eq("kind", "group_contribution").eq("source", groupId)
          .gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(1).maybeSingle(),
        "lastContribution",
      ) as Tx | null;
    },
    async chainEventsForRef(refHex) {
      // topics are stored decoded: ["attested", "<ref hex>"], ["contribution_recorded", group, "<ref>"],
      // ["limit_set", ["Ref", "<ref>"]].
      const rows = must(
        await db.from("chain_events").select("type, tx_hash, ledger, topics, data, created_at").in("type", REF_EVENT_TYPES)
          .or(`topics->>1.eq.${refHex},topics->>2.eq.${refHex},topics->1->>1.eq.${refHex}`)
          .order("ledger", { ascending: false }).limit(500),
        "chainEventsForRef",
      );
      return rows as ChainEvent[];
    },
    async groupRecords(onchainGroupId) {
      return must(
        await db.from("chain_events").select("type, tx_hash, ledger, topics, data, created_at").eq("type", "contribution_recorded")
          .eq("topics->>1", String(onchainGroupId)).order("ledger", { ascending: false }).limit(500),
        "groupRecords",
      ) as ChainEvent[];
    },
    async chainPending(refHex) {
      const { count, error } = await db.from("chain_outbox").select("id", { count: "exact", head: true }).neq("status", "done")
        .or(`args->>user_ref.eq.${refHex},args->>member_ref.eq.${refHex}`);
      if (error) throw new Error(`chainPending: ${error.message}`);
      return count ?? 0;
    },
    async updateUser(userId, patch) {
      if (Object.keys(patch).length === 0) return;
      must(await db.from("users").update(patch).eq("id", userId).select("id"), "updateUser");
    },
  };
}
