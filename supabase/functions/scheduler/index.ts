// scheduler: periodic jobs, every minute from Supabase Cron (x-plus-cron-secret) or on demand
// (x-plus-secret). Everything it starts is idempotent: refs are fixed per round / per cash-out, so
// overlapping runs queue nothing twice.
//
//   1. Expire unanswered actions (cash-ins from agents wait 24 hours, then expire).
//   2. Refresh the wallet_balances cache from Horizon for every Nigeria wallet.
//   3. Ajo payouts: a pooled group whose round is due gets group_payout (partner pays; the contract
//      repays the recipient's open advance first, then sends the rest).
//   4. Cash-outs nobody redeemed: after 7 days she claims the claimable balance back.
// Then it kicks chain-worker.
//
// POST .../scheduler/warm (cron every 5 minutes): pings every demo function's /health so none of
// them is cold during a demo. Does nothing unless the Supabase secret DEMO_WARM is "true".
//
// POST .../scheduler/provision { "signer": "anchor_ng" } (x-plus-secret): give a system account
// (the partner bank's anchor, which pays bank transfers into wallets) a wallet: a new key straight
// into Vault, and a partner-sponsored account with an NGNT trustline queued on partner's queue.
// Idempotent; answers the public address only. The issuer then funds it (pnpm demo:reset ng).
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { mayRunJob } from "../_shared/cron.ts";
import { DEMO_FUNCTIONS, health, json, kickChainWorker } from "../_shared/http.ts";
import { contractReader, refreshBalances } from "../_shared/ng-chain.ts";
import { payoutSplit } from "../_shared/tools-ng.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const chain = contractReader(Deno.env.get("PLUS_CONTRACT_ID") ?? "");
const RETURN_MARGIN_MS = 60 * 60_000; // the on-chain "not before 7 days" clock starts a few seconds after the row

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

async function expireActions() {
  return must(await db.rpc("expire_stale_actions"), "expire_stale_actions") as number;
}

async function refreshNigeria() {
  const users = must(
    await db.from("users").select("id").eq("market_id", "ng").not("stellar_pub", "is", null).is("archived_at", null),
    "ng users",
  ) as { id: string }[];
  const ms = await refreshBalances(db, users.map((u) => u.id));
  ms.sort((a, b) => a - b);
  return { wallets: users.length, horizon_ms_p50: ms[Math.floor(ms.length / 2)] ?? null };
}

async function ajoPayouts(now: Date) {
  const groups = must(
    await db.from("groups").select("id, name, onchain_id").eq("market_id", "ng").eq("mode", "pooled").not("onchain_id", "is", null),
    "groups",
  ) as { id: string; name: string; onchain_id: number }[];
  const queued: string[] = [];
  for (const grp of groups) {
    const g = await chain.group(grp.onchain_id);
    // Ledger time trails the wall clock by a few seconds: wait 10 s past due so NotDue can't happen.
    // An empty pot (nobody paid this round) is not worth a transaction: skip it rather than pay ₦0.
    if (!g || g.pot_minor === 0n || g.next_due.getTime() + 10_000 > now.getTime()) continue;
    const round = Math.floor(g.next_due.getTime() / 1000);
    const recipientPub = g.members[g.turn];
    const { data: recipient } = await db.from("users").select("id").eq("stellar_pub", recipientPub).maybeSingle();
    let transactionId: string | null = null;
    if (recipient && g.pot_minor > 0n) {
      // What reaches her wallet: the pot, minus her open advance (the contract repays that first).
      const { net } = payoutSplit(g.pot_minor, await chain.advanceOf(recipientPub));
      if (net > 0n) {
        const t = must(
          await db.from("transactions").upsert({
            user_id: recipient.id,
            market_id: "ng",
            kind: "incoming",
            source: "ajo_payout",
            amount: net.toString(),
            currency: "NGN",
            rail: "stellar",
            ref: `ajo_payout:${grp.onchain_id}:${round}`,
            status: "pending",
          }, { onConflict: "rail,ref", ignoreDuplicates: true }).select("id"),
          "payout transaction",
        ) as { id: string }[];
        transactionId = t[0]?.id ?? null;
      }
    }
    must(
      await db.rpc("chain_enqueue_on", {
        p_signer: "partner",
        p_kind: "contract",
        p_ref: `group_payout:${grp.onchain_id}:${round}`,
        p_args: {
          fn: "group_payout",
          args: [{ t: "u32", v: grp.onchain_id }],
          ...(transactionId ? { transaction_id: transactionId } : {}),
          ...(recipient ? { refresh_user_ids: [recipient.id] } : {}),
        },
      }),
      "enqueue payout",
    );
    queued.push(`${grp.name} round ${round}`);
  }
  return queued;
}

async function returnCashOuts(now: Date) {
  const rows = must(
    await db.from("cash_out_codes").select("id, user_id, amount, create_outbox_id, users(secret_name)").eq("status", "issued")
      .lt("expires_at", new Date(now.getTime() - RETURN_MARGIN_MS).toISOString()),
    "expired cash-outs",
  ) as unknown as { id: string; user_id: string; amount: number; create_outbox_id: number; users: { secret_name: string | null } }[];
  const returned: string[] = [];
  for (const c of rows) {
    const { data: out } = await db.from("chain_outbox").select("status, result").eq("id", c.create_outbox_id).maybeSingle();
    const balanceId = (out?.result as { balance_id?: string } | null)?.balance_id;
    const signer = /^STELLAR_SECRET_([A-Z][A-Z0-9_]{0,31})$/.exec(c.users?.secret_name ?? "")?.[1]?.toLowerCase();
    if (out?.status !== "done" || !balanceId || !signer) continue;
    const t = must(
      await db.from("transactions").upsert({
        user_id: c.user_id,
        market_id: "ng",
        kind: "incoming",
        source: "cash_out_returned",
        amount: c.amount,
        currency: "NGN",
        rail: "stellar",
        ref: `cash_out_return:${c.id}`,
        status: "pending",
      }, { onConflict: "rail,ref", ignoreDuplicates: true }).select("id"),
      "return transaction",
    ) as { id: string }[];
    must(
      await db.rpc("chain_enqueue_on", {
        p_signer: signer,
        p_kind: "claimable_claim",
        p_ref: `cash_out_return:${c.id}`,
        p_args: { balance_id: balanceId, ...(t[0] ? { transaction_id: t[0].id } : {}) },
      }),
      "enqueue return",
    );
    must(await db.from("cash_out_codes").update({ status: "returned" }).eq("id", c.id).eq("status", "issued"), "mark returned");
    returned.push(c.id);
  }
  return returned;
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`scheduler ${name} failed`, msg);
    return { error: msg };
  }
}

/** Ping each demo function's /health in parallel; returns each one's time and whether it was cold. */
async function warm() {
  if (Deno.env.get("DEMO_WARM") !== "true") return { ok: true, skipped: "DEMO_WARM is not true" };
  const base = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
  const results = await Promise.all(DEMO_FUNCTIONS.filter((f) => f !== "scheduler").map(async (fn) => {
    const t = performance.now();
    try {
      const r = await fetch(`${base}/${fn}/health`, { signal: AbortSignal.timeout(10_000) });
      const body = await r.json().catch(() => ({})) as { cold?: boolean };
      return { fn, status: r.status, cold: body.cold ?? null, ms: Math.round(performance.now() - t) };
    } catch (e) {
      return { fn, status: 0, error: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - t) };
    }
  }));
  return { ok: true, warmed: results };
}

const SYSTEM_SIGNERS = new Set(["anchor_ng"]);

async function provision(req: Request) {
  let signer = "";
  try {
    signer = String((await req.json())?.signer ?? "");
  } catch {
    // no body
  }
  if (!SYSTEM_SIGNERS.has(signer)) return { ok: false, error: "unknown_signer" };
  const { StellarSdk } = await import("../_shared/stellar.ts");
  let pub: string;
  const existing = must(await db.rpc("wallet_key_get", { p_signer: signer }), "wallet_key_get") as string | null;
  if (existing) pub = StellarSdk.Keypair.fromSecret(existing).publicKey();
  else {
    const kp = StellarSdk.Keypair.random();
    must(await db.rpc("wallet_key_put", { p_signer: signer, p_secret: kp.secret() }), "wallet_key_put");
    pub = kp.publicKey();
  }
  const out = must(
    await db.rpc("chain_enqueue_on", {
      p_signer: "partner",
      p_kind: "create_wallet",
      p_ref: `create_wallet:${signer}`,
      p_args: { pub, signer, trustlines: ["NGNT"] },
    }),
    "enqueue",
  ) as number;
  await kickChainWorker();
  const { data: row } = await db.from("chain_outbox").select("status, tx_hash").eq("id", out).single();
  return { ok: true, signer, pub, outbox_id: out, status: row?.status, tx_hash: row?.tx_hash ?? null };
}

Deno.serve(async (req) => {
  const up = health(req, "scheduler");
  if (up) return up;
  if (!(await mayRunJob(req, db))) return json({ error: "unauthorized" }, 401);
  if (new URL(req.url).pathname.endsWith("/warm")) return json(await warm());
  if (new URL(req.url).pathname.endsWith("/provision")) return json(await provision(req));
  const now = new Date();
  const t0 = performance.now();
  const expired = await step("expire", expireActions);
  const [balances, payouts, returns] = await Promise.all([
    step("balances", refreshNigeria),
    step("payouts", () => ajoPayouts(now)),
    step("cash_out_returns", () => returnCashOuts(now)),
  ]);
  const queued = (Array.isArray(payouts) && payouts.length > 0) || (Array.isArray(returns) && returns.length > 0);
  if (queued) await kickChainWorker();
  return json({ ok: true, expired, balances, payouts, returns, ms: Math.round(performance.now() - t0) });
});
