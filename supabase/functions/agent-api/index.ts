// agent-api: for cash agents (Mama Bisi) on the agent page (/agent).
//
//   POST /functions/v1/agent-api/me                                   -> float, today's limit, recent work
//   POST /functions/v1/agent-api/record_cash_in { phone, amount, idempotency_key }
//   POST /functions/v1/agent-api/check_code     { phone, code }       -> amount to hand over
//   POST /functions/v1/agent-api/redeem_code    { phone, code }       -> claims the cash-out on Stellar
//
// Authorization: Bearer <Supabase access token> of a login linked through helpers.auth_user_id, with
// helpers.role = 'agent'.
//
// Cash-in moves no money by itself: it creates a pending action for the customer ("Mama Bisi says
// you gave her ₦500. Is that right?"). Only her Yes sends NGNT from the agent's float to her wallet
// (and repays 10% to an open advance, in the same queued sequence). Daily limit and float are
// checked here for a friendly answer and again, atomically, in agent_record_cash_in.
//
// Cash-out: the customer shows a 6-digit code. Only its HMAC is stored; five wrong codes lock it.
// redeem_code queues the agent's claim of the claimable balance (after she has handed over cash).
// The same codes pay people who are not on Plus: Funmi pays a phone number, they get a code by SMS
// (simulated) and collect the cash here with their phone number and the code.
//
// Registering a customer (sign-up at the agent) goes through agent-tools/start_onboarding with the
// agent's login: the same steps as in the app, with the customer answering on this screen.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { agentCashInCheck, agentCashInReadback, cashOutRedeemable, normalizeNgPhone, sameHex } from "../_shared/agent.ts";
import { bearer, json, kickChainWorker, preflight, readJson, health, withCors } from "../_shared/http.ts";
import { demoOff, demoRateLimited, MONEY_TOOLS } from "../_shared/demo.ts";
import { formatMoney, getMarket } from "../_shared/markets.ts";
import { horizonBalances } from "../_shared/ng-chain.ts";
import { parseMajorAmount } from "../_shared/payees.ts";
import { cashOutCodeHash } from "../_shared/tools-ng.ts";
import { dayStart } from "../_shared/tools.ts";
import { receiveAllowed } from "../_shared/tiers.ts";

declare const EdgeRuntime: { waitUntil(p: PromiseLike<unknown>): void };

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ?? "Test SDF Network ; September 2015";
const EXPLORER = `https://stellar.expert/explorer/${PASSPHRASE.startsWith("Public") ? "public" : "testnet"}`;
const CODE_SECRET = Deno.env.get("CASHOUT_CODE_SECRET") ?? "";
const NG = getMarket("ng");
const MAX_ATTEMPTS = NG.cashOutCode?.maxAttempts ?? 5;
const show = (kobo: bigint | number) => formatMoney(BigInt(kobo), "ng");

type Agent = { id: string; name: string; role: string; market_id: "ng"; daily_limit: number; active: boolean; stellar_pub: string | null };

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

async function usedToday(a: Agent): Promise<bigint> {
  const rows = must(
    await db.from("cash_events").select("amount").eq("helper_id", a.id).in("status", ["awaiting_user", "confirmed"])
      .gte("created_at", dayStart("ng", new Date())),
    "usedToday",
  ) as { amount: number }[];
  return rows.reduce((s, r) => s + BigInt(r.amount), 0n);
}

/** Cash-ins that will still leave her float: awaiting a Yes, or confirmed and not yet on-chain. */
async function committed(a: Agent): Promise<bigint> {
  const rows = must(
    await db.from("cash_events").select("amount, status, rail_ref").eq("helper_id", a.id).in("status", ["awaiting_user", "confirmed"])
      .gte("created_at", new Date(Date.now() - 2 * 86_400_000).toISOString()),
    "committed",
  ) as { amount: number; status: string; rail_ref: string | null }[];
  const confirmedIds = rows.filter((r) => r.status === "confirmed" && r.rail_ref).map((r) => r.rail_ref!);
  const pending = new Set<string>();
  if (confirmedIds.length > 0) {
    const txs = must(await db.from("transactions").select("id").in("id", confirmedIds).eq("status", "pending"), "pending txs") as { id: string }[];
    for (const t of txs) pending.add(t.id);
  }
  return rows.reduce((s, r) => (r.status === "awaiting_user" || (r.rail_ref && pending.has(r.rail_ref)) ? s + BigInt(r.amount) : s), 0n);
}

async function floatOf(a: Agent): Promise<{ float: bigint; horizon_ms: number }> {
  if (!a.stellar_pub) return { float: 0n, horizon_ms: 0 };
  const r = await horizonBalances(a.stellar_pub);
  return { float: r.balances.NGNT ?? 0n, horizon_ms: r.ms };
}

async function me(a: Agent) {
  const [used, held, f] = await Promise.all([usedToday(a), committed(a), floatOf(a)]);
  const limit = BigInt(a.daily_limit);
  const left = limit > used ? limit - used : 0n;
  const free = f.float > held ? f.float - held : 0n;
  const recent = must(
    await db.from("cash_events").select("id, amount, status, created_at, rail_ref, users(name)").eq("helper_id", a.id)
      .gte("created_at", new Date(Date.now() - 7 * 86_400_000).toISOString()).order("created_at", { ascending: false }).limit(20),
    "recent",
  ) as unknown as { id: string; amount: number; status: string; created_at: string; rail_ref: string | null; users: { name: string | null } | null }[];
  const txIds = recent.map((r) => r.rail_ref).filter((x): x is string => Boolean(x));
  const txs = txIds.length
    ? must(await db.from("transactions").select("id, status, chain_tx_hash").in("id", txIds), "recent txs") as { id: string; status: string; chain_tx_hash: string | null }[]
    : [];
  const byId = new Map(txs.map((t) => [t.id, t]));
  const redeemed = must(
    await db.from("cash_out_codes").select("id, amount, redeemed_at, claim_outbox_id, recipient_name, users(name)").eq("redeemed_by", a.id)
      .order("redeemed_at", { ascending: false }).limit(10),
    "redeemed",
  ) as unknown as { id: string; amount: number; redeemed_at: string; claim_outbox_id: number | null; recipient_name: string | null; users: { name: string | null } | null }[];
  const outIds = redeemed.map((r) => r.claim_outbox_id).filter((x): x is number => x !== null);
  const outs = outIds.length
    ? must(await db.from("chain_outbox").select("id, status, tx_hash").in("id", outIds), "claims") as { id: number; status: string; tx_hash: string | null }[]
    : [];
  const outById = new Map(outs.map((o) => [o.id, o]));
  return {
    agent: { id: a.id, name: a.name, role: a.role },
    float_minor: String(f.float),
    float_text: show(f.float),
    float_free_text: show(free),
    horizon_ms: f.horizon_ms,
    wallet_url: a.stellar_pub ? `${EXPLORER}/account/${a.stellar_pub}` : null,
    limit_text: show(limit),
    used_today_text: show(used),
    left_today_minor: String(left),
    left_today_text: show(left),
    recent: recent.map((r) => {
      const t = r.rail_ref ? byId.get(r.rail_ref) : undefined;
      return {
        id: r.id,
        name: r.users?.name ?? "Customer",
        amount_text: show(r.amount),
        status: r.status === "confirmed" && t?.status === "completed" ? "on_stellar" : r.status,
        at: r.created_at,
        url: t?.chain_tx_hash ? `${EXPLORER}/tx/${t.chain_tx_hash}` : null,
      };
    }),
    redeemed: redeemed.map((r) => {
      const o = r.claim_outbox_id !== null ? outById.get(r.claim_outbox_id) : undefined;
      return {
        id: r.id,
        name: r.recipient_name ? `${r.recipient_name} (from ${r.users?.name ?? "a Plus user"})` : r.users?.name ?? "Customer",
        amount_text: show(r.amount),
        at: r.redeemed_at,
        status: o?.status === "done" ? "on_stellar" : "sending",
        url: o?.status === "done" && o.tx_hash ? `${EXPLORER}/tx/${o.tx_hash}` : null,
      };
    }),
  };
}

type Customer = { id: string; name: string | null; stellar_pub: string | null; kyc_tier: number; market_id: "ng" };

async function customer(phoneRaw: unknown): Promise<Customer | null> {
  const phone = typeof phoneRaw === "string" ? normalizeNgPhone(phoneRaw) : null;
  if (!phone) return null;
  const { data } = await db.from("users").select("id, name, stellar_pub, kyc_tier, market_id").eq("market_id", "ng").eq("wa_phone", phone)
    .is("archived_at", null).maybeSingle();
  return data as Customer | null;
}

/** Her balance plus money already on its way in (kobo), for her tier's balance limit. */
async function heldAndIncoming(userId: string): Promise<bigint> {
  const [{ data: b }, { data: pend }] = await Promise.all([
    db.from("wallet_balances").select("amount").eq("user_id", userId).eq("asset", "NGNT").maybeSingle(),
    db.from("transactions").select("amount").eq("user_id", userId).eq("status", "pending").eq("rail", "stellar").in("kind", ["incoming", "advance"]),
  ]);
  return BigInt(b?.amount ?? 0) + (pend ?? []).reduce((s, r) => s + BigInt(r.amount), 0n);
}

const ERRORS: Record<string, [number, string]> = {
  daily_limit_exceeded: [409, "That is over your limit for today."],
  float_too_low: [409, "Your float is too low. Top up your float first."],
  helper_inactive: [403, "Your agent account is not active."],
  not_a_customer: [404, "No Plus wallet with that phone number."],
  invalid_amount: [400, "Enter an amount."],
  wrong_code: [400, "That code is not right."],
  code_expired: [410, "That code has expired. The money went back to her wallet."],
  too_many_attempts: [423, "Too many wrong codes. Ask her to make a new code in her app."],
  not_redeemable: [409, "That code was already used."],
  not_on_chain_yet: [409, "That cash-out is still being sent. Try again in a few seconds."],
  no_cash_out: [404, "No cash-out or payment code is waiting for this number."],
  balance_limit: [409, "Her wallet can't hold that much at her level."],
  signup_not_finished: [409, "Her account is not open yet."],
};

function fail(error: string, extra: Record<string, unknown> = {}) {
  const [status, text] = ERRORS[error] ?? [500, "Something went wrong. Try again."];
  return json({ error: ERRORS[error] ? error : "internal", text, ...extra }, status);
}

type WaitingCode = {
  id: string;
  user_id: string;
  amount: number;
  status: string;
  expires_at: string;
  attempts: number;
  code_hash: string;
  create_outbox_id: number | null;
  recipient_name: string | null;
};
const CODE_COLS = "id, user_id, amount, status, expires_at, attempts, code_hash, create_outbox_id, recipient_name";

/**
 * Codes waiting for this phone number: her own cash-outs (a Plus user), and money someone paid to this
 * number by code. Wrong codes count against every waiting one. Each code's HMAC is keyed by the
 * account that made it.
 */
async function matchCode(phone: string, userId: string | null, code: string) {
  const [own, paid] = await Promise.all([
    userId
      ? db.from("cash_out_codes").select(CODE_COLS).eq("user_id", userId).is("recipient_phone", null).eq("status", "issued").order("created_at", { ascending: false }).limit(10)
      : Promise.resolve({ data: [], error: null }),
    db.from("cash_out_codes").select(CODE_COLS).eq("recipient_phone", phone).eq("status", "issued").order("created_at", { ascending: false }).limit(10),
  ]);
  const list = [...(must(own, "cash-outs") as WaitingCode[]), ...(must(paid, "paid codes") as WaitingCode[])];
  if (list.length === 0) return { error: "no_cash_out" as const };
  if (!/^\d{6}$/.test(code)) return { error: "wrong_code" as const };
  let hit: WaitingCode | undefined;
  for (const c of list) {
    if (sameHex(c.code_hash, await cashOutCodeHash(CODE_SECRET, c.user_id, code))) {
      hit = c;
      break;
    }
  }
  if (!hit) {
    let left = MAX_ATTEMPTS;
    for (const c of list) {
      if (!cashOutRedeemable(c, new Date(), MAX_ATTEMPTS).ok) continue;
      const r = await db.rpc("cash_out_redeem", { p_cash_out_id: c.id, p_helper_id: null, p_code_ok: false, p_balance_id: null });
      if (!r.error) left = Math.min(left, MAX_ATTEMPTS - (r.data as { attempts: number }).attempts);
    }
    return { error: "wrong_code" as const, attempts_left: Math.max(0, left) };
  }
  const ok = cashOutRedeemable(hit, new Date(), MAX_ATTEMPTS);
  if (!ok.ok) return { error: ok.error };
  return { hit };
}

Deno.serve(withCors(async (req) => {
  const up = health(req, "agent-api");
  if (up) return up;
  const pre = preflight(req);
  if (pre) return pre;
  const endpoint = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  const body = await readJson(req);
  if (body instanceof Response) return body;

  const token = bearer(req);
  if (!token) return json({ error: "unauthorized" }, 401);
  const { data: auth, error: authErr } = await db.auth.getUser(token);
  if (authErr || !auth.user) return json({ error: "unauthorized" }, 401);
  const { data: row } = await db.from("helpers").select("id, name, role, market_id, daily_limit, active, stellar_pub, demo_login")
    .eq("auth_user_id", auth.user.id).maybeSingle();
  if (!row || !row.active || row.role !== "agent" || row.market_id !== "ng") return json({ error: "not_an_agent" }, 403);
  const a = row as Agent;
  const off = demoOff(row);
  if (off) return off;
  if (MONEY_TOOLS.has(endpoint)) {
    const limited = await demoRateLimited(db, row as { id: string; demo_login: boolean }, endpoint);
    if (limited) return limited;
  }

  try {
    if (endpoint === "me") return json(await me(a));

    if (endpoint === "record_cash_in") {
      const key = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
      const amount = parseMajorAmount(body.amount);
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) return json({ error: "bad_request" }, 400);
      if (amount === null) return fail("invalid_amount");
      const who = await customer(body.phone);
      if (!who?.stellar_pub) return fail("not_a_customer");
      // Her tier's balance limit: cash that would take her wallet over it is refused before anything is recorded.
      const full = receiveAllowed(who, await heldAndIncoming(who.id), amount);
      if (full) return json({ error: full.error, text: full.text }, 409);

      const [used, held, f] = await Promise.all([usedToday(a), committed(a), floatOf(a)]);
      const check = agentCashInCheck({ used, limit: BigInt(a.daily_limit), float: f.float, committed: held, amount });
      if (!check.ok) return json({ error: check.error, text: check.text }, check.error === "invalid_amount" ? 400 : 409);

      const { data: ce, error } = await db.rpc("agent_record_cash_in", {
        p_helper_id: a.id,
        p_user_id: who.id,
        p_amount: Number(amount),
        p_idempotency_key: key,
        p_readback: agentCashInReadback(a.name, amount),
        p_float: Number(f.float),
      });
      if (error) {
        if (!ERRORS[error.message]) console.error("agent_record_cash_in failed", error.message);
        return fail(error.message);
      }
      return json({
        ok: true,
        text: `Recorded ${show(amount)} for ${who.name ?? "her"}. It goes to her wallet when she says Yes in her Plus app.`,
        cash_event: { id: ce.id, status: ce.status, amount_text: show(amount) },
        ...(await me(a)),
      });
    }

    if (endpoint === "check_code" || endpoint === "redeem_code") {
      const phone = typeof body.phone === "string" ? normalizeNgPhone(body.phone) : null;
      if (!phone) return fail("not_a_customer");
      const who = await customer(phone);
      const code = typeof body.code === "string" ? body.code.replace(/\s/g, "") : "";
      const m = await matchCode(phone, who?.id ?? null, code);
      if ("error" in m) return fail(m.error!, "attempts_left" in m ? { attempts_left: m.attempts_left } : {});
      if (endpoint === "check_code") {
        const name = m.hit.recipient_name ?? who?.name ?? "them";
        return json({ ok: true, cash_out_id: m.hit.id, name, amount_text: show(m.hit.amount), text: `Code is right. Give ${name} ${show(m.hit.amount)} in cash, then tap Done.` });
      }
      const { data: out } = await db.from("chain_outbox").select("status, result").eq("id", m.hit.create_outbox_id).maybeSingle();
      const balanceId = out?.status === "done" ? (out.result as { balance_id?: string } | null)?.balance_id ?? null : null;
      const { error } = await db.rpc("cash_out_redeem", { p_cash_out_id: m.hit.id, p_helper_id: a.id, p_code_ok: true, p_balance_id: balanceId });
      if (error) {
        if (!ERRORS[error.message]) console.error("cash_out_redeem failed", error.message);
        return fail(error.message);
      }
      EdgeRuntime.waitUntil(kickChainWorker());
      return json({ ok: true, text: `Done. ${show(m.hit.amount)} is coming to your float on Stellar.`, ...(await me(a)) });
    }

    return json({ error: "unknown_endpoint", endpoint }, 404);
  } catch (err) {
    console.error(`agent-api ${endpoint} failed`, err instanceof Error ? err.message : err);
    return json({ error: "internal" }, 500);
  }
}));
