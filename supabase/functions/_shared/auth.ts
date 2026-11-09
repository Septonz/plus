// Shared-secret check for calls from the voice agent (ElevenLabs tools).
// The caller sends the secret in the "x-plus-secret" header; it must equal AGENT_SHARED_SECRET.
// Fails closed: if the env var is missing or empty, every request is rejected.

export const SECRET_HEADER = "x-plus-secret";

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

export function hasValidAgentSecret(req: Request): boolean {
  const expected = Deno.env.get("AGENT_SHARED_SECRET");
  if (!expected) return false;
  const provided = req.headers.get(SECRET_HEADER);
  if (!provided) return false;
  return constantTimeEqual(provided, expected);
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
