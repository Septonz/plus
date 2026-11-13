// Piece 12: public test mode, the guest side of agent-tools.
//
//   guest_start       (public) "Try Plus now" / "Try the agent app": a guest place for this device
//                     (guest_assign), reset first if someone used it before, and a one-time sign-in.
//   guest_status      (a guest) her test checklist, ticked from what she has actually done.
//   guest_cash_in     (a guest) "Pretend Mama Bisi recorded ₦5,000 cash for you": a real cash-in
//                     from the shared demo agent, waiting for her Yes like any other.
//   guest_agent_paid  (a guest) "Pretend an agent paid this out": the shared demo agent redeems her
//                     newest cash-out code (the claimable balance goes to its float on Stellar).
// Only guests reach the last three; presenters and everyone else get 404.
import type { SupabaseClient } from "@supabase/supabase-js";
import { agentCashInReadback } from "../_shared/agent.ts";
import { GUEST_PIN, convergeAndRecord, guestName, inReset, type PoolRow, SHOP, startReset } from "../_shared/guests.ts";
import { json, kickChainWorker } from "../_shared/http.ts";
import { formatMoney } from "../_shared/markets.ts";
import { horizonBalances } from "../_shared/ng-chain.ts";
import { signInToken } from "../_shared/store-onboarding.ts";
import type { ToolResult, User } from "../_shared/tools.ts";
import { addressHash } from "../_shared/voice-mode.ts";

declare const EdgeRuntime: { waitUntil(p: PromiseLike<unknown>): void };

export const GUEST_TOOLS: ReadonlySet<string> = new Set(["guest_status", "guest_cash_in", "guest_agent_paid"]);
const PER_HOUR = 10; // new guest sessions per address an hour
const PRETEND_CASH = 5_000n * 100n;
const show = (kobo: bigint) => formatMoney(kobo, "ng");

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

const salt = () => Deno.env.get("VOICE_SESSION_SECRET") ?? "";

async function deviceHash(device: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt()}:guest-device:${device}`)));
  return Array.from(d.slice(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
}

async function helperSignInToken(db: SupabaseClient, helperId: string): Promise<string> {
  const h = must(await db.from("helpers").select("auth_user_id").eq("id", helperId).single(), "guest agent") as { auth_user_id: string | null };
  if (!h.auth_user_id) throw new Error("guest agent has no login");
  const { data: au, error } = await db.auth.admin.getUserById(h.auth_user_id);
  if (error || !au.user?.email) throw new Error(`guest agent login: ${error?.message ?? "no email"}`);
  const { data, error: linkErr } = await db.auth.admin.generateLink({ type: "magiclink", email: au.user.email });
  if (linkErr || !data.properties?.hashed_token) throw new Error(`guest agent link: ${linkErr?.message ?? "no token"}`);
  return data.properties.hashed_token;
}

/** Move a place's Stellar reset along for up to ~50 seconds after the response has gone. */
async function settle(db: SupabaseClient, kind: string, slot: number) {
  const env = { contractId: Deno.env.get("PLUS_CONTRACT_ID") ?? "", ngntSac: Deno.env.get("NGNT_SAC_ID") ?? "" };
  const until = Date.now() + 50_000;
  while (Date.now() < until) {
    const { data } = await db.from("guest_pool").select("*").eq("kind", kind).eq("slot", slot).single();
    const row = data as PoolRow | null;
    if (!row || !inReset(row)) return;
    await convergeAndRecord(db, row, env);
    await kickChainWorker();
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

export async function guestStart(db: SupabaseClient, req: Request, args: Record<string, unknown>): Promise<Response> {
  const kind = args.kind === "agent" ? "agent" : "trader";
  const device = typeof args.device_id === "string" ? args.device_id : "";
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(device)) return json({ ok: false, error: "bad_request" }, 400);
  if (!salt()) return json({ ok: false, error: "not_configured", text: "The test accounts are not set up yet." }, 503);
  const { data, error } = await db.rpc("guest_assign", {
    p_kind: kind, p_device_hash: await deviceHash(device), p_ip_hash: await addressHash(req, salt()), p_per_hour: PER_HOUR,
  });
  if (error) throw new Error(`guest_assign: ${error.message}`);
  const r = data as { ok: boolean; error?: string; slot: number; user_id: string | null; helper_id: string | null; same: boolean; busy: boolean; needs_reset: boolean };
  if (!r.ok) {
    return r.error === "too_many_sessions"
      ? json({ ok: false, error: r.error, text: "Lots of test accounts have been opened from this network in the last hour. Try again a little later." }, 429)
      : json({ ok: false, error: r.error ?? "no_guests", text: "The test accounts are being set up. Try again in a few minutes." }, 503);
  }
  if (r.needs_reset) {
    await startReset(db, kind, r.slot);
    EdgeRuntime.waitUntil(settle(db, kind, r.slot).catch((e) => console.error("guest settle", e instanceof Error ? e.message : e)));
  }
  const token = kind === "trader" ? await signInToken(db, r.user_id!) : await helperSignInToken(db, r.helper_id!);
  const name = kind === "trader"
    ? ((await db.from("users").select("name").eq("id", r.user_id!).single()).data?.name ?? guestName(r.slot))
    : ((await db.from("helpers").select("name").eq("id", r.helper_id!).single()).data?.name ?? "Guest agent");
  return json({
    ok: true, kind, name, sign_in_token: token, same: r.same, busy: r.busy, fresh: r.needs_reset,
    ...(kind === "trader" ? { test_pin: GUEST_PIN } : {}),
    ...(r.busy ? { notice: "Someone else may be testing this account too." } : {}),
  });
}

type Step = { key: string; done: boolean };

async function checklist(db: SupabaseClient, user: User, since: string): Promise<Step[]> {
  const count = async (q: PromiseLike<{ count: number | null }>) => ((await q).count ?? 0) > 0;
  const head = { count: "exact" as const, head: true };
  const [seen, shop, saved, loan, shared, viewed, code] = await Promise.all([
    count(db.from("tool_calls").select("id", head).eq("user_id", user.id).eq("tool", "guest_status").eq("args->>seen", "activity").gte("created_at", since)),
    count(db.from("transactions").select("id", head).eq("user_id", user.id).eq("kind", "pay").ilike("counterparty", "Mama Put%").neq("status", "failed").gte("created_at", since)),
    count(db.from("transactions").select("id", head).eq("user_id", user.id).eq("kind", "saved").neq("source", "guest_reset").neq("source", "guest_reset_ledger")
      .lte("amount", -100_000).neq("status", "failed").gte("created_at", since)),
    count(db.from("loans").select("id", head).eq("user_id", user.id).gte("created_at", since)),
    count(db.from("record_shares").select("id", head).eq("user_id", user.id).gte("created_at", since)),
    count(db.from("record_shares").select("id", head).eq("user_id", user.id).gte("created_at", since).not("first_viewed_at", "is", null)),
    count(db.from("cash_out_codes").select("id", head).eq("user_id", user.id).gte("created_at", since)),
  ]);
  return [
    { key: "balance", done: seen },
    { key: "shop", done: shop },
    { key: "save", done: saved },
    { key: "loan", done: loan },
    { key: "share", done: shared && viewed },
    { key: "cashout", done: code },
  ];
}

export async function guestTool(db: SupabaseClient, tool: string, user: User, args: Record<string, unknown>): Promise<ToolResult> {
  const pool = must(await db.from("guest_pool").select("slot, assigned_at, last_seen_at, reset_started_at, reset_done_at, reset_step").eq("user_id", user.id).maybeSingle(), "guest place") as
    { slot: number; assigned_at: string | null; reset_started_at: string | null; reset_done_at: string | null; reset_step: string | null } | null;
  if (!pool) return { ok: false, error: "not_a_guest", text: "This is not a test account." };

  if (tool === "guest_status") {
    const since = pool.assigned_at ?? pool.reset_started_at ?? new Date(0).toISOString();
    const ready = !pool.reset_started_at || (pool.reset_done_at !== null && pool.reset_done_at >= pool.reset_started_at);
    const { data: mine } = await db.from("users").select("wa_phone").eq("id", user.id).single();
    const { data: shop } = await db.from("users").select("pay_code").eq("wa_phone", SHOP.phone).is("archived_at", null).maybeSingle();
    return {
      ok: true, guest: true, slot: pool.slot, test_pin: GUEST_PIN, ready, steps: await checklist(db, user, since),
      shop_code: shop?.pay_code ?? null, phone: mine?.wa_phone ?? null, text: "Your test account.",
    };
  }

  const { data: agent } = await db.from("helpers").select("id, name, stellar_pub, daily_limit").eq("guest_slot", 0).maybeSingle();
  if (!agent?.stellar_pub) return { ok: false, error: "no_demo_agent", text: "The demo agent isn't set up yet." };

  if (tool === "guest_cash_in") {
    const { count } = await db.from("cash_events").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "awaiting_user");
    if ((count ?? 0) > 0) return { ok: false, error: "already_waiting", text: "A cash-in is already waiting for your Yes. Check Home." };
    const float = (await horizonBalances(agent.stellar_pub)).balances.NGNT ?? 0n;
    const { data: ce, error } = await db.rpc("agent_record_cash_in", {
      p_helper_id: agent.id, p_user_id: user.id, p_amount: Number(PRETEND_CASH), p_idempotency_key: `guest-${crypto.randomUUID()}`,
      p_readback: agentCashInReadback(agent.name, PRETEND_CASH), p_float: Number(float),
    });
    if (error) {
      console.error("guest_cash_in", error.message);
      return { ok: false, error: error.message, text: "The demo agent can't do that just now. Try again in a minute." };
    }
    return { ok: true, cash_event: { id: (ce as { id: string }).id }, text: `${agent.name} recorded ${show(PRETEND_CASH)} cash for you. Say Yes on Home to get it.` };
  }

  if (tool === "guest_agent_paid") {
    const id = typeof args.cash_out_id === "string" && /^[0-9a-f-]{36}$/.test(args.cash_out_id) ? args.cash_out_id : null;
    let q = db.from("cash_out_codes").select("id, amount, create_outbox_id").eq("user_id", user.id).eq("status", "issued");
    if (id) q = q.eq("id", id);
    const code = must(await q.order("created_at", { ascending: false }).limit(1).maybeSingle(), "her code") as { id: string; amount: string; create_outbox_id: number | null } | null;
    if (!code) return { ok: false, error: "no_cash_out", text: "No cash-out code is waiting. Make one first." };
    const { data: out } = await db.from("chain_outbox").select("status, result").eq("id", code.create_outbox_id).maybeSingle();
    const balanceId = out?.status === "done" ? (out.result as { balance_id?: string } | null)?.balance_id ?? null : null;
    if (!balanceId) return { ok: false, error: "not_ready", text: "Your code is still being written to Stellar. Try again in a few seconds." };
    const { error } = await db.rpc("cash_out_redeem", { p_cash_out_id: code.id, p_helper_id: agent.id, p_code_ok: true, p_balance_id: balanceId });
    if (error) {
      console.error("guest_agent_paid", error.message);
      return { ok: false, error: error.message, text: "That code can't be paid out now." };
    }
    EdgeRuntime.waitUntil(kickChainWorker());
    return { ok: true, text: `${agent.name} paid you ${show(BigInt(code.amount))} in cash. The money goes to her float on Stellar.` };
  }
  return { ok: false, error: "unknown_tool", text: "Not a test tool." };
}
