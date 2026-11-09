// scheduler: periodic jobs (expiring pending actions, group cycles, reminders). Stub only.
import "@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(() => Response.json({ ok: true, function: "scheduler", status: "stub" }));
