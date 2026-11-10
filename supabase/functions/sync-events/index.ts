// sync-events: copies Plus contract events from Stellar RPC into chain_events, so the voice
// tools and the app read the on-chain record from Postgres (never the slow live RPC).
//
// Runs every minute (Supabase Cron). The RPC cursor is kept in sync_state ('chain_events');
// event_id is unique, so re-reading a page changes nothing. Topics and data are stored decoded:
// bytes as hex, i128 as strings, enums as [variant, value], e.g.
//   type "attested"              topics ["attested", "<user_ref>"]             data {kind, amount, payment_ref}
//   type "contribution_recorded" topics ["contribution_recorded", 0, "<ref>"]  data {amount, payment_ref}
import "@supabase/functions-js/edge-runtime.d.ts";
import { Buffer } from "node:buffer";
import { createClient } from "@supabase/supabase-js";
import { jobGate } from "../_shared/cron.ts";
import { json } from "../_shared/http.ts";
import { StellarSdk, withRetry } from "../_shared/stellar.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { rpc, scValToNative } = StellarSdk;
const RPC_URL = Deno.env.get("STELLAR_RPC_URL") || "https://soroban-testnet.stellar.org";
const CONTRACT_ID = Deno.env.get("PLUS_CONTRACT_ID") ?? "";
const CURSOR_KEY = "chain_events";
const PAGE = 100;
const RUN_BUDGET_MS = 60_000;

/** JSON-safe: bytes -> hex, bigint -> string, enum variants stay arrays. */
export function plain(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return Buffer.from(v as Uint8Array).toString("hex");
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

/** Ledger of an RPC cursor ("<toid>-<n>"; the ledger is the toid's high 32 bits). */
function cursorLedger(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    return Number(BigInt(cursor.split("-")[0]) >> 32n);
  } catch {
    return 0;
  }
}

Deno.serve(async (req) => {
  // First, before every route (/health included): 401 without the cron or agent secret.
  const gate = await jobGate(req, db, "sync-events");
  if (gate) return gate;
  if (!CONTRACT_ID) return json({ error: "not_configured" }, 503);
  const server = new rpc.Server(RPC_URL);
  const started = Date.now();
  let inserted = 0;
  let pages = 0;

  try {
    const { data: state } = await db.from("sync_state").select("cursor").eq("key", CURSOR_KEY).maybeSingle();
    let cursor: string | undefined = state?.cursor || undefined;
    let startLedger: number | undefined;
    if (!cursor) {
      // First run: from the oldest ledger the RPC still keeps (about 7 days on testnet).
      const health = await withRetry(() => server.getHealth());
      startLedger = (health as { oldestLedger?: number }).oldestLedger ?? (health.latestLedger - 100_000);
      startLedger += 10; // the oldest ledger can roll off while we ask
    }
    while (Date.now() - started < RUN_BUDGET_MS) {
      const filters = [{ type: "contract" as const, contractIds: [CONTRACT_ID] }];
      const res = await withRetry(() =>
        cursor ? server.getEvents({ filters, cursor, limit: PAGE }) : server.getEvents({ filters, startLedger: startLedger!, limit: PAGE })
      );
      pages++;
      const rows = res.events.map((e) => {
        const topics = e.topic.map((t) => plain(scValToNative(t)));
        const value = plain(scValToNative(e.value));
        return {
          event_id: e.id,
          ledger: e.ledger,
          tx_hash: e.txHash,
          type: String(topics[0] ?? "unknown"),
          topics,
          data: value && typeof value === "object" && !Array.isArray(value) ? value : { value },
          created_at: e.ledgerClosedAt,
        };
      });
      if (rows.length > 0) {
        const { error } = await db.from("chain_events").upsert(rows, { onConflict: "event_id", ignoreDuplicates: true });
        if (error) throw error;
        inserted += rows.length;
      }
      if (res.cursor) {
        cursor = res.cursor;
        const { error } = await db.from("sync_state").upsert({ key: CURSOR_KEY, cursor });
        if (error) throw error;
      }
      // RPC scans a limited ledger window per request (about 10,000 ledgers), so a short page
      // doesn't mean we're done: keep going until the cursor reaches the latest ledger.
      if (res.events.length < PAGE && cursorLedger(cursor) >= res.latestLedger - 1) break;
    }
    return json({ ok: true, inserted, pages, ms: Date.now() - started });
  } catch (err) {
    console.error("sync-events failed", err instanceof Error ? err.message : err);
    return json({ ok: false, error: err instanceof Error ? err.message : "internal", inserted }, 500);
  }
});
