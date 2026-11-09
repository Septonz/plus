// payout-sim: simulated partner-bank / UPI payouts. Stub only.
import "@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(() => Response.json({ ok: true, function: "payout-sim", status: "stub" }));
