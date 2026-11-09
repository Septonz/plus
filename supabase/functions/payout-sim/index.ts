// payout-sim: simulated money arriving in an Indian user's partner-bank account (demo only).
//
//   POST /functions/v1/payout-sim/state_transfer_arrives  { idempotency_key, user_id? }  -> Rs 1,000
//   POST /functions/v1/payout-sim/wages_arrive            { idempotency_key, amount, user_id? }
//
// Who may call: staff (JWT app_metadata.role = "staff", any user_id), or a demo login
// (app_metadata.demo = true) for her own account only. Both go through sim_credit, so auto-save
// and the on-chain attest (chain_outbox) happen automatically, and a retried call with the same
// idempotency_key credits once.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { bearer, json, kickChainWorker, preflight, readJson } from "../_shared/http.ts";
import { formatMoney, formatSpokenMoney } from "../_shared/markets.ts";
import { parseMajorAmount } from "../_shared/payees.ts";

declare const EdgeRuntime: { waitUntil(p: PromiseLike<unknown>): void };

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const STATE_TRANSFER_PAISE = 100_000n; // Rs 1,000
const MAX_WAGES_PAISE = 2_000_000n; // Rs 20,000 per simulated payment

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const endpoint = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  const body = await readJson(req);
  if (body instanceof Response) return body;

  const token = bearer(req);
  if (!token) return json({ error: "unauthorized" }, 401);
  const { data: auth, error: authErr } = await db.auth.getUser(token);
  if (authErr || !auth.user) return json({ error: "unauthorized" }, 401);
  const meta = (auth.user.app_metadata ?? {}) as { role?: string; demo?: boolean };

  let userId: string | null = null;
  if (meta.role === "staff") {
    userId = typeof body.user_id === "string" ? body.user_id : null;
    if (!userId) return json({ error: "user_id_required" }, 400);
  } else if (meta.demo === true) {
    const { data } = await db.from("users").select("id").eq("auth_user_id", auth.user.id).maybeSingle();
    userId = data?.id ?? null;
    if (!userId || (body.user_id !== undefined && body.user_id !== userId)) return json({ error: "forbidden" }, 403);
  } else {
    return json({ error: "forbidden", text: "Only staff or demo accounts can simulate payouts." }, 403);
  }

  const key = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) return json({ error: "idempotency_key_required" }, 400);

  let amount: bigint;
  let source: string;
  if (endpoint === "state_transfer_arrives") {
    amount = STATE_TRANSFER_PAISE;
    source = "state_transfer";
  } else if (endpoint === "wages_arrive") {
    const a = parseMajorAmount(body.amount);
    if (a === null || a > MAX_WAGES_PAISE) return json({ error: "invalid_amount", text: "Wages from ₹1 to ₹20,000." }, 400);
    amount = a;
    source = "wages";
  } else {
    return json({ error: "unknown_endpoint", endpoint }, 404);
  }

  const { data: tx, error } = await db.rpc("sim_credit", {
    p_user_id: userId,
    p_amount: Number(amount),
    p_source: source,
    p_ref: `payout:${source}:${key}`,
  });
  if (error) {
    console.error("payout-sim sim_credit failed", error.message);
    return json({ error: error.message === "no_sim_account" ? "no_sim_account" : "internal" }, error.message === "no_sim_account" ? 400 : 500);
  }
  EdgeRuntime.waitUntil(kickChainWorker());

  const { data: acct } = await db.from("sim_bank_accounts").select("balance_paise, savings_paise").eq("user_id", userId).single();
  return json({
    ok: true,
    text: `${formatSpokenMoney(amount, "in")} arrived from ${source === "wages" ? "wages" : "the state transfer"}.`,
    transaction_id: tx.id,
    amount_text: formatMoney(amount, "in"),
    balance_text: acct ? formatMoney(BigInt(acct.balance_paise), "in") : null,
    savings_text: acct ? formatMoney(BigInt(acct.savings_paise), "in") : null,
  });
});
