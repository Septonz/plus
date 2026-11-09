// sync-events: pulls Plus contract events from Stellar into Postgres. Stub only.
import "@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(() => Response.json({ ok: true, function: "sync-events", status: "stub" }));
