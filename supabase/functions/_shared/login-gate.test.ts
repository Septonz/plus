// agent-api, helper-api and voice-session run with verify_jwt = false (approved 2026-11-10; see
// CLAUDE.md), so each checks her login itself. This test pins the only statements allowed before
// that check: the public /health, the CORS preflight, reading the method or endpoint name, and (in
// voice-session, where a sign-up's onboarding token travels in the body) reading the body. Nothing
// before the check touches the database or runs an endpoint.
import { assert, assertEquals } from "jsr:@std/assert@1";

const ALLOWED_BEFORE_LOGIN: RegExp[] = [
  /^const up = health\(req, "[a-z-]+"\);$/,
  /^if \(up\) return up;$/,
  /^const pre = preflight\(req\);$/,
  /^if \(pre\) return pre;$/,
  /^const endpoint = new URL\(req\.url\)\.pathname\.split\("\/"\)\.filter\(Boolean\)\.pop\(\) \?\? "";$/,
  /^if \(req\.method !== "POST"\) return json\(\{ error: "method_not_allowed" \}, 405\);$/,
];
const BODY_READ: RegExp[] = [/^let body: Record<string, unknown> = \{\};$/, /^try \{$/, /^body = await req\.json\(\);$/, /^\} catch \{$/, /^\}$/, /^let user: .* = null;$/];

const FUNCTIONS: Record<string, { first: string; body: boolean }> = {
  "agent-api": { first: "const token = bearer(req);", body: false },
  "helper-api": { first: "const token = bearer(req);", body: false },
  // A sign-up in progress has no login yet: its signed onboarding token is checked instead.
  "voice-session": { first: "if (hasSessionToken(body.onboarding_token)) {", body: true },
};

for (const [fn, want] of Object.entries(FUNCTIONS)) {
  Deno.test(`${fn}: checks her login (or onboarding token) before anything else`, async () => {
    const src = await Deno.readTextFile(new URL(`../${fn}/index.ts`, import.meta.url));
    const serves = src.split("Deno.serve(");
    assertEquals(serves.length, 2, "exactly one Deno.serve");
    const lines = serves[1].split("\n").slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
    const allowed = want.body ? [...ALLOWED_BEFORE_LOGIN, ...BODY_READ] : ALLOWED_BEFORE_LOGIN;
    const i = lines.findIndex((l) => !allowed.some((r) => r.test(l)));
    assertEquals(lines[i], want.first, "the first real step must be the login check");
    assert(!lines.slice(0, i).some((l) => /\bdb\./.test(l)), "no database call before the login check");
    const after = lines.slice(i, i + 12).join("\n");
    assert(/return json\(\{ error: "unauthorized" \}, 401\)|return json\(\{ error: "invalid_onboarding" \}, 401\)/.test(after), "a missing or bad login returns 401");
    if (fn === "voice-session") assert(/verifySession\(body\.onboarding_token/.test(after), "the onboarding token is verified, not trusted");
    else assert(/db\.auth\.getUser\(token\)/.test(after), "the bearer token is checked with Supabase Auth");
  });
}
