// agent-tools: tool endpoint for the Plus voice agent. Stub only.
import "@supabase/functions-js/edge-runtime.d.ts";
import { hasValidAgentSecret, unauthorized } from "../_shared/auth.ts";

Deno.serve((req) => {
  if (!hasValidAgentSecret(req)) return unauthorized();
  return Response.json({ ok: true, function: "agent-tools", status: "stub" });
});
