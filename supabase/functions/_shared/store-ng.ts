// NgStore backed by Postgres (service role). Money moves only through ng_execute_pending_action,
// which queues Stellar work in chain_outbox; nothing here writes balances except the Horizon
// refresh of the wallet_balances cache.
import type { SupabaseClient } from "@supabase/supabase-js";
import { contractReader, refreshBalances } from "./ng-chain.ts";
import { verifyPin as verifyPinRow } from "./pin.ts";
import type { CashOut, NgGroup, NgStore, NgTx } from "./tools-ng.ts";
import type { Action, CashIn } from "./tools.ts";

const ACTION_COLS = "id, user_id, kind, params, readback, status, result, expires_at, created_by, created_at";
const TX_COLS = "id, kind, source, amount, status, created_at, chain_tx_hash";
const OUT_KINDS = ["pay", "group_contribution", "cash_out"];

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

export function supabaseNgStore(db: SupabaseClient, contractId: string): NgStore {
  return {
    async balances(userId) {
      const rows = must(await db.from("wallet_balances").select("asset, amount, updated_at").eq("user_id", userId), "balances") as {
        asset: string;
        amount: number | string;
        updated_at: string;
      }[];
      const get = (a: string) => BigInt(rows.find((r) => r.asset === a)?.amount ?? 0);
      const updated = rows.map((r) => r.updated_at).sort().at(-1) ?? null;
      return { NGNT: get("NGNT"), USDC: get("USDC"), updated_at: updated };
    },
    async refreshBalances(userId) {
      await refreshBalances(db, [userId]);
    },
    async available(userId) {
      return BigInt(must(await db.rpc("ng_available", { p_user_id: userId }), "ng_available") as number | string);
    },
    async hasPin(userId) {
      const { count, error } = await db.from("user_credentials").select("user_id", { count: "exact", head: true }).eq("user_id", userId);
      if (error) throw new Error(`hasPin: ${error.message}`);
      return (count ?? 0) > 0;
    },
    verifyPin: (userId, pin) => verifyPinRow(db, userId, pin),
    async payees(userId) {
      return must(await db.from("payees").select("id, name, stellar_address").eq("user_id", userId).order("name"), "payees");
    },
    async paidSince(userId, sinceIso) {
      const rows = must(
        await db.from("transactions").select("amount").eq("user_id", userId).in("kind", OUT_KINDS).neq("status", "failed").gte("created_at", sinceIso),
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
      return must(await db.from("pending_actions").select(ACTION_COLS).eq("id", id).eq("user_id", userId).maybeSingle(), "action") as Action | null;
    },
    async pendingActions(userId) {
      return must(
        await db.from("pending_actions").select(ACTION_COLS).eq("user_id", userId).eq("status", "pending")
          .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(5),
        "pendingActions",
      ) as Action[];
    },
    async execute(id, userId, extra) {
      const r = must(await db.rpc("ng_execute_pending_action", { p_action_id: id, p_user_id: userId, p_extra: extra }), "ng_execute_pending_action") as {
        action: Action;
        claimed: boolean;
      };
      return r;
    },
    async rejectAction(id, userId) {
      return must(await db.rpc("reject_pending_action", { p_action_id: id, p_user_id: userId }), "reject_pending_action") as Action;
    },
    async awaitingCashIns(userId) {
      const rows = must(
        await db.from("cash_events").select("id, amount, created_at, pending_action_id, helpers(name)").eq("user_id", userId)
          .eq("direction", "in").eq("status", "awaiting_user").order("created_at", { ascending: false }).limit(5),
        "awaitingCashIns",
      ) as unknown as { id: string; amount: number; created_at: string; pending_action_id: string | null; helpers: { name: string } | null }[];
      return rows.map((r): CashIn => ({
        cash_event_id: r.id,
        pending_action_id: r.pending_action_id,
        amount: r.amount,
        helper_name: r.helpers?.name ?? "An agent",
        created_at: r.created_at,
      }));
    },
    async transactions(userId, limit) {
      return must(
        await db.from("transactions").select(TX_COLS).eq("user_id", userId).order("created_at", { ascending: false }).limit(limit),
        "transactions",
      ) as NgTx[];
    },
    async myGroup(userId) {
      // Her newest pooled group with an on-chain id (the Bodija Market Ajo for Funmi).
      const links = must(
        await db.from("group_members").select("group_id, groups!inner(id, name, onchain_id, mode, created_at)").eq("user_id", userId)
          .eq("groups.mode", "pooled").not("groups.onchain_id", "is", null),
        "myGroup",
      ) as unknown as { group_id: string; groups: { id: string; name: string; onchain_id: number; created_at: string } }[];
      const g = links.map((l) => l.groups).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (!g) return null;
      const members = must(await db.from("group_members").select("name, position, user_id").eq("group_id", g.id).order("position"), "members");
      return { id: g.id, name: g.name, onchain_id: g.onchain_id, members } as NgGroup;
    },
    async agentWallets() {
      const rows = must(
        await db.from("helpers").select("stellar_pub").eq("market_id", "ng").eq("role", "agent").eq("active", true).not("stellar_pub", "is", null)
          .order("created_at"),
        "agentWallets",
      ) as { stellar_pub: string }[];
      return rows.map((r) => r.stellar_pub);
    },
    async cashOuts(userId) {
      return must(
        await db.from("cash_out_codes").select("id, action_id, amount, status, expires_at, created_at").eq("user_id", userId)
          .order("created_at", { ascending: false }).limit(20),
        "cashOuts",
      ) as CashOut[];
    },
    async setCashOutCode(userId, cashOutId, codeHash) {
      const rows = must(
        await db.from("cash_out_codes").update({ code_hash: codeHash, attempts: 0 }).eq("id", cashOutId).eq("user_id", userId)
          .eq("status", "issued").gt("expires_at", new Date().toISOString()).select("id"),
        "setCashOutCode",
      ) as { id: string }[];
      return rows.length === 1;
    },
    chain: contractReader(contractId),
  };
}
