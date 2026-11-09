// Who is calling? ElevenLabs fills the system dynamic variable `system__caller_id` with:
// - phone calls (Twilio / SIP): the caller's number, "+"-prefixed (e.g. "+14155552671");
// - WhatsApp (messages and calls): the WhatsApp user ID, which today is the phone number as
//   digits without "+" (e.g. "919876543210"). Meta is moving to Business-Scoped User IDs
//   (BSUIDs), which are not phone numbers; those cannot be matched and return null.
// Each agent-tools webhook binds a body property to it ("dynamic_variable": "system__caller_id"),
// so the LLM can never choose whose account is read.

/** Body fields accepted for the caller, in order of preference. */
export const CALLER_FIELDS = ["caller_id", "system__caller_id", "caller_phone"] as const;

/** Normalize a caller id to E.164 ("+919876543210"), or null if it is not a phone number. */
export function callerPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^whatsapp:/i, "");
  if (!/^\+?[0-9 ()-]+$/.test(trimmed)) return null; // BSUID or anything else that is not a number
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) return null;
  return `+${digits}`;
}

export function callerFromBody(body: Record<string, unknown>): string | null {
  for (const f of CALLER_FIELDS) {
    const phone = callerPhone(body[f]);
    if (phone) return phone;
  }
  return null;
}
