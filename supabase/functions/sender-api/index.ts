// sender-api: API for family abroad sending money (SEP-31, family pots). Stub only.
import "@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(() => Response.json({ ok: true, function: "sender-api", status: "stub" }));
