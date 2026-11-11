// NgStore backed by Postgres (service role). Money moves only through ng_execute_pending_action,
// which queues Stellar work in chain_outbox; nothing here writes balances except the Horizon
// refresh of the wallet_balances cache.
import type { SupabaseClient } from "@supabase/supabase-js";
import { contractReader, refreshBalances } from "./ng-chain.ts";
import { verifyPin as verifyPinRow } from "./pin.ts";
import type { Payee } from "./payees.ts";
import type { CreditAsset, CreditLoan, CreditWeek } from "./lending.ts";
import { type CashOut, newPayCode, type NgGroup, type NgStore, type NgTx, type PlusPeer, type RecordShare, type Vouch, type VouchCheck } from "./tools-ng.ts";
import type { Action, CashIn } from "./tools.ts";

const ACTION_COLS = "id, user_id, kind, params, readback, status, result, expires_at, created_by, created_at";
const TX_COLS = "id, kind, source, amount, status, created_at, chain_tx_hash, counterparty";
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
      return must(await db.from("payees").select("id, name, stellar_address, phone, bank_code, account_number, account_name").eq("user_id", userId).order("name"), "payees");
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
    async transactions(userId, limit, includeHidden = false) {
      // Piece 11: the demo reset's own rows and everything before its curated history are hidden
      // from her lists (hidden_from_history); they stay for audit, balances and Stellar.
      const q = db.from("transactions").select(TX_COLS).eq("user_id", userId);
      return must(
        await (includeHidden ? q : q.eq("hidden_from_history", false)).order("created_at", { ascending: false }).limit(limit),
        "transactions",
      ) as NgTx[];
    },
    async contributionTxs(onchainId) {
      // sync-events stores contract events with decoded topics: ["contributed", <group id>, "<G...>"].
      const rows = must(
        await db.from("chain_events").select("tx_hash, topics").eq("type", "contributed").eq("topics->>1", String(onchainId))
          .order("ledger", { ascending: false }).limit(200),
        "contributionTxs",
      ) as { tx_hash: string; topics: unknown[] }[];
      const latest = new Map<string, string>();
      for (const r of rows) {
        const who = String(r.topics[2] ?? "");
        if (who && !latest.has(who)) latest.set(who, r.tx_hash);
      }
      return latest;
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
        await db.from("cash_out_codes").select("id, action_id, amount, status, expires_at, created_at, recipient_name").eq("user_id", userId)
          .order("created_at", { ascending: false }).limit(20),
        "cashOuts",
      ) as CashOut[];
    },
    async recordShares(userId) {
      return must(
        await db.from("record_shares").select("id, created_at, expires_at, revoked_at, first_viewed_at, views, last_viewed_at")
          .eq("user_id", userId).order("created_at", { ascending: false }).limit(50),
        "recordShares",
      ) as RecordShare[];
    },
    async revokeRecordShare(userId, shareId) {
      const rows = must(
        await db.from("record_shares").update({ revoked_at: new Date().toISOString() }).eq("id", shareId).eq("user_id", userId)
          .is("revoked_at", null).select("id"),
        "revokeRecordShare",
      ) as { id: string }[];
      return rows.length === 1;
    },
    async vouches(userId) {
      type Row = { id: string; status: Vouch["status"]; voucher_user_id: string; borrower_user_id: string; loan_id: string | null; credit_tx_hash: string | null; created_at: string; groups: { name: string } | null };
      const cols = "id, status, voucher_user_id, borrower_user_id, loan_id, credit_tx_hash, created_at, groups(name)";
      const [g, r] = await Promise.all([
        db.from("vouches").select(cols).eq("voucher_user_id", userId).order("created_at", { ascending: false }).limit(50),
        db.from("vouches").select(cols).eq("borrower_user_id", userId).order("created_at", { ascending: false }).limit(50),
      ]);
      const given = must(g, "vouches given") as unknown as Row[];
      const received = must(r, "vouches received") as unknown as Row[];
      const ids = [...new Set([...given.map((x) => x.borrower_user_id), ...received.map((x) => x.voucher_user_id)])];
      const people = ids.length ? must(await db.from("users").select("id, name").in("id", ids), "vouch names") as { id: string; name: string | null }[] : [];
      const first = (id: string) => people.find((p) => p.id === id)?.name?.split(" ")[0] ?? null;
      const view = (x: Row, other: string): Vouch => ({
        id: x.id, status: x.status, other_user_id: other, other_name: first(other), group_name: x.groups?.name ?? null,
        loan_id: x.loan_id, credit_tx_hash: x.credit_tx_hash, created_at: x.created_at,
      });
      return { given: given.map((x) => view(x, x.borrower_user_id)), received: received.map((x) => view(x, x.voucher_user_id)) };
    },
    async ajoPeers(userId) {
      const mine = must(await db.from("group_members").select("group_id, groups!inner(name, created_at)").eq("user_id", userId), "my ajos") as unknown as
        { group_id: string; groups: { name: string; created_at: string } }[];
      if (!mine.length) return [];
      const rows = must(
        await db.from("group_members").select("group_id, user_id, users!inner(id, name, archived_at)").in("group_id", mine.map((m) => m.group_id))
          .not("user_id", "is", null).neq("user_id", userId).is("users.archived_at", null),
        "ajo peers",
      ) as unknown as { group_id: string; user_id: string; users: { name: string | null } }[];
      // Newest ajo first; each person once.
      const order = [...mine].sort((a, b) => b.groups.created_at.localeCompare(a.groups.created_at));
      const out = new Map<string, { user_id: string; name: string | null; group_name: string }>();
      for (const m of order) for (const r of rows.filter((x) => x.group_id === m.group_id)) {
        if (!out.has(r.user_id)) out.set(r.user_id, { user_id: r.user_id, name: r.users.name, group_name: m.groups.name });
      }
      return [...out.values()];
    },
    async vouchCheck(voucherId, borrowerId) {
      return must(await db.rpc("vouch_check", { p_voucher: voucherId, p_borrower: borrowerId }), "vouch_check") as VouchCheck;
    },
    async withdrawVouch(voucherId, vouchId) {
      if (!/^[0-9a-f-]{36}$/i.test(vouchId)) return false;
      return must(await db.rpc("vouch_withdraw", { p_voucher: voucherId, p_vouch_id: vouchId }), "vouch_withdraw") as boolean;
    },
    async setCashOutCode(userId, cashOutId, codeHash) {
      const rows = must(
        await db.from("cash_out_codes").update({ code_hash: codeHash, attempts: 0 }).eq("id", cashOutId).eq("user_id", userId)
          .eq("status", "issued").gt("expires_at", new Date().toISOString()).select("id"),
        "setCashOutCode",
      ) as { id: string }[];
      return rows.length === 1;
    },
    async payCode(userId) {
      for (let i = 0; i < 5; i++) {
        const { data } = await db.from("users").select("pay_code").eq("id", userId).single();
        if (data?.pay_code) return data.pay_code as string;
        const { error } = await db.from("users").update({ pay_code: newPayCode() }).eq("id", userId).is("pay_code", null);
        if (error && !/duplicate|unique/i.test(error.message)) throw new Error(`pay code: ${error.message}`);
      }
      throw new Error("pay code: could not make a unique one");
    },
    async plusUserByPayCode(code) {
      return must(
        await db.from("users").select("id, name, market_id, kyc_tier, stellar_pub").eq("pay_code", code).is("archived_at", null).maybeSingle(),
        "plusUserByPayCode",
      ) as PlusPeer | null;
    },
    async plusUserByPhone(phone) {
      const r = must(
        await db.from("users").select("id, name, market_id, kyc_tier, stellar_pub").eq("wa_phone", phone).is("archived_at", null).maybeSingle(),
        "plusUserByPhone",
      );
      return r as PlusPeer | null;
    },
    async pendingIncoming(userId) {
      const rows = must(
        await db.from("transactions").select("amount").eq("user_id", userId).eq("status", "pending").eq("rail", "stellar").in("kind", ["incoming", "advance"]),
        "pendingIncoming",
      ) as { amount: number | string }[];
      return rows.reduce((s, r) => s + BigInt(r.amount), 0n);
    },
    async savePayee(userId, p) {
      return must(
        await db.from("payees").upsert({ user_id: userId, name: p.name, phone: p.phone, stellar_address: p.stellar_address }, { onConflict: "user_id,phone" })
          .select("id, name, stellar_address, phone").single(),
        "savePayee",
      ) as Payee;
    },
    async saveBankPayee(userId, p) {
      return must(
        await db.from("payees").upsert({ user_id: userId, ...p }, { onConflict: "user_id,name" })
          .select("id, name, stellar_address, phone, bank_code, account_number, account_name").single(),
        "saveBankPayee",
      ) as Payee;
    },
    async bankTransferIn(userId, amount, repay, ref, sender) {
      const r = must(
        await db.rpc("ng_bank_transfer_in", { p_user_id: userId, p_amount: Number(amount), p_repay: Number(repay), p_ref: ref, p_sender: sender }),
        "ng_bank_transfer_in",
      ) as { transaction_id: string; repay?: number; loan_repay_transaction_id?: string | null };
      return { transaction_id: r.transaction_id, repay: BigInt(r.repay ?? 0), loan: !!r.loan_repay_transaction_id };
    },
    async credit(userId) {
      const [u, weeks, assets, loans, events] = await Promise.all([
        db.from("users").select("borrowing_frozen_until").eq("id", userId).single(),
        db.rpc("ng_credit_weeks", { p_user_id: userId }),
        db.from("assets").select("id, type, description, estimated_value, level, status").eq("user_id", userId).order("created_at"),
        db.rpc("ng_loans", { p_user_id: userId }),
        db.from("loan_events").select("kind, amount, note, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(10),
      ]);
      const big = (v: unknown) => BigInt(String(v ?? 0));
      return {
        frozen_until: (must(u, "credit user") as { borrowing_frozen_until: string | null }).borrowing_frozen_until,
        weeks: (must(weeks, "ng_credit_weeks") as Record<string, unknown>[]).map((w) => ({
          week: Number(w.week), money_in: big(w.money_in), qualifying_tx: Number(w.qualifying_tx), saved: big(w.saved), savings: big(w.savings ?? 0),
        }) as CreditWeek),
        assets: (must(assets, "assets") as Record<string, unknown>[]).map((a) => ({ ...a, estimated_value: big(a.estimated_value) }) as CreditAsset),
        loans: (must(loans, "ng_loans") as Record<string, unknown>[]).map((l) => ({
          ...l,
          principal: big(l.principal), cost: big(l.cost), total: big(l.total), repaid: big(l.repaid), in_flight: big(l.in_flight),
          period_paid: big(l.period_paid), outstanding: big(l.outstanding), minimum: big(l.minimum),
        }) as unknown as CreditLoan),
        events: must(events, "loan_events") as { kind: string; amount: number | null; note: string | null; created_at: string }[],
      };
    },
    async savingsGoal(userId) {
      const g = must(await db.from("savings_goals").select("id, name, goal, onchain_pot_id").eq("user_id", userId).eq("status", "active").maybeSingle(), "savings goal") as
        { id: string; name: string; goal: number | string; onchain_pot_id: number | null } | null;
      if (!g) return null;
      const saved = must(await db.rpc("ng_savings_balance", { p_user_id: userId }), "ng_savings_balance") as number | string | null;
      return { id: g.id, name: g.name, goal: BigInt(g.goal), onchain_pot_id: g.onchain_pot_id, saved: BigInt(saved ?? 0) };
    },
    async setSavingsGoal(userId, name, goal, assetSac) {
      const r = must(await db.rpc("ng_savings_goal_set", { p_user_id: userId, p_name: name, p_goal: Number(goal), p_asset_sac: assetSac }), "ng_savings_goal_set") as { created: boolean };
      return { created: !!r.created };
    },
    async updateProfile(userId, patch) {
      must(await db.from("users").update(patch).eq("id", userId), "profile");
    },
    async setAutoSave(userId, bps) {
      must(await db.from("users").update({ auto_save_bps: bps }).eq("id", userId), "auto save");
    },
    chain: contractReader(contractId),
  };
}
