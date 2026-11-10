// helper-api: for helpers (group leaders like Meena) on the helper page.
//
//   POST /functions/v1/helper-api/me                                -> who she is, today's total, her people
//   POST /functions/v1/helper-api/record_cash_in { user_id, amount, idempotency_key }
//
// Authorization: Bearer <Supabase access token> of a login linked through helpers.auth_user_id.
// Recording cash moves no money: it creates a cash_event awaiting the user's answer and a pending
// action created_by "helper" ("Meena says you gave her ₹500 in cash. Is that right?"). Only the
// user's Yes runs sim_credit. The daily limit is enforced in the same database transaction.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { cashInAllowance, cashInReadback } from "../_shared/helper.ts";
import { bearer, json, preflight, readJson, health, withCors } from "../_shared/http.ts";
import { demoOff, demoRateLimited, MONEY_TOOLS } from "../_shared/demo.ts";
import { formatMoney, type MarketId } from "../_shared/markets.ts";
import { parseMajorAmount } from "../_shared/payees.ts";
import { dayStart } from "../_shared/tools.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Helper = { id: string; name: string; role: string; market_id: MarketId; daily_limit: number; active: boolean };

async function usedToday(h: Helper): Promise<bigint> {
  const { data, error } = await db.from("cash_events").select("amount").eq("helper_id", h.id)
    .in("status", ["awaiting_user", "confirmed"]).gte("created_at", dayStart(h.market_id, new Date()));
  if (error) throw error;
  return (data ?? []).reduce((s, r) => s + BigInt(r.amount), 0n);
}

async function people(h: Helper) {
  const { data: groups } = await db.from("groups").select("id, name").eq("leader_helper_id", h.id);
  const ids = (groups ?? []).map((g) => g.id);
  if (ids.length === 0) return [];
  const { data, error } = await db.from("group_members").select("user_id, users!inner(id, name)").in("group_id", ids)
    .not("user_id", "is", null);
  if (error) throw error;
  const seen = new Map<string, { user_id: string; name: string }>();
  for (const r of data ?? []) {
    const u = r.users as unknown as { id: string; name: string | null };
    seen.set(u.id, { user_id: u.id, name: u.name ?? "Member" });
  }
  return [...seen.values()];
}

async function me(h: Helper) {
  const used = await usedToday(h);
  const limit = BigInt(h.daily_limit);
  const { data: recent } = await db.from("cash_events").select("id, amount, status, created_at, users(name)").eq("helper_id", h.id)
    .gte("created_at", new Date(Date.now() - 7 * 86_400_000).toISOString()).order("created_at", { ascending: false }).limit(20);
  return {
    helper: { id: h.id, name: h.name, role: h.role },
    limit_text: formatMoney(limit, h.market_id),
    used_today_text: formatMoney(used, h.market_id),
    left_today_minor: String(limit > used ? limit - used : 0n),
    left_today_text: formatMoney(limit > used ? limit - used : 0n, h.market_id),
    people: await people(h),
    recent: (recent ?? []).map((r) => ({
      id: r.id,
      name: (r.users as unknown as { name: string | null } | null)?.name ?? "Member",
      amount_text: formatMoney(BigInt(r.amount), h.market_id),
      status: r.status,
      at: r.created_at,
    })),
  };
}

const ERRORS: Record<string, [number, string]> = {
  daily_limit_exceeded: [409, "That is over your limit for today."],
  not_your_member: [403, "You can only record cash for people in your group."],
  helper_inactive: [403, "Your helper account is not active."],
  invalid_amount: [400, "Enter an amount."],
};

Deno.serve(withCors(async (req) => {
  const up = health(req, "helper-api");
  if (up) return up;
  const pre = preflight(req);
  if (pre) return pre;
  const endpoint = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  // Her login first, before the body is read or any endpoint runs (verify_jwt is off; login-gate.test.ts).
  const token = bearer(req);
  if (!token) return json({ error: "unauthorized" }, 401);
  const { data: auth, error: authErr } = await db.auth.getUser(token);
  if (authErr || !auth.user) return json({ error: "unauthorized" }, 401);
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const { data: helper } = await db.from("helpers").select("id, name, role, market_id, daily_limit, active, demo_login")
    .eq("auth_user_id", auth.user.id).maybeSingle();
  if (!helper || !helper.active) return json({ error: "not_a_helper" }, 403);
  const h = helper as Helper;
  const off = demoOff(helper);
  if (off) return off;
  if (MONEY_TOOLS.has(endpoint)) {
    const limited = await demoRateLimited(db, helper as { id: string; demo_login: boolean }, endpoint);
    if (limited) return limited;
  }

  try {
    if (endpoint === "me") return json(await me(h));

    if (endpoint === "record_cash_in") {
      const userId = typeof body.user_id === "string" ? body.user_id : "";
      const key = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
      const amount = parseMajorAmount(body.amount);
      if (!userId || !/^[A-Za-z0-9_-]{8,80}$/.test(key)) return json({ error: "bad_request" }, 400);
      if (amount === null) return json({ error: "invalid_amount", text: ERRORS.invalid_amount[1] }, 400);

      // Friendly early answer; the database re-checks atomically.
      const allowance = cashInAllowance(await usedToday(h), BigInt(h.daily_limit), amount);
      if (!allowance.ok) {
        return json({
          error: "daily_limit_exceeded",
          text: `${ERRORS.daily_limit_exceeded[1]} You can record ${formatMoney(allowance.left, h.market_id)} more today.`,
        }, 409);
      }

      const { data: ce, error } = await db.rpc("helper_record_cash_in", {
        p_helper_id: h.id,
        p_user_id: userId,
        p_amount: Number(amount),
        p_idempotency_key: key,
        p_readback: cashInReadback(h.name, amount, h.market_id),
      });
      if (error) {
        const [status, text] = ERRORS[error.message] ?? [500, "Something went wrong. Try again."];
        if (status === 500) console.error("helper_record_cash_in failed", error.message);
        return json({ error: ERRORS[error.message] ? error.message : "internal", text }, status);
      }
      return json({
        ok: true,
        text: `Recorded ${formatMoney(amount, h.market_id)}. It counts once she says Yes in her Plus app.`,
        cash_event: { id: ce.id, status: ce.status, amount_text: formatMoney(amount, h.market_id) },
        ...(await me(h)),
      });
    }
    return json({ error: "unknown_endpoint", endpoint }, 404);
  } catch (err) {
    console.error(`helper-api ${endpoint} failed`, err instanceof Error ? err.message : err);
    return json({ error: "internal" }, 500);
  }
}));
