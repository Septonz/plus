import { assert, assertEquals } from "jsr:@std/assert@1";
import { mintSession } from "./session.ts";
import { clientAddress, dailyCapFrom, mintPresenterToken, presenterCodeMatches, presenterUnlockId, voiceModeFrom } from "./voice-mode.ts";

const SECRET = "x".repeat(40);
const ID = "3f6c1b8e-6f4e-4a7e-9d6a-0d5f3c2b1a90";

Deno.test("VOICE_MODE: missing or unknown is presenter", () => {
  assertEquals(voiceModeFrom(undefined), "presenter");
  assertEquals(voiceModeFrom(""), "presenter");
  assertEquals(voiceModeFrom("loud"), "presenter");
  assertEquals(voiceModeFrom(" OFF "), "off");
  assertEquals(voiceModeFrom("on"), "on");
});

Deno.test("VOICE_DAILY_SESSION_CAP: default 40, a whole number otherwise", () => {
  assertEquals(dailyCapFrom(undefined), 40);
  assertEquals(dailyCapFrom(""), 40);
  assertEquals(dailyCapFrom("12"), 12);
  assertEquals(dailyCapFrom("0"), 0);
  assertEquals(dailyCapFrom("-3"), 40);
  assertEquals(dailyCapFrom("2.5"), 40);
});

Deno.test("presenter token: round trip, 7 days, and never a plus_session", async () => {
  const now = 1_800_000_000;
  const t = await mintPresenterToken(ID, SECRET, now);
  assertEquals(t.expiresAt, now + 7 * 86_400);
  assertEquals(await presenterUnlockId(t.token, SECRET, now + 60), ID);
  assertEquals(await presenterUnlockId(t.token, SECRET, now + 7 * 86_400 + 1), null, "expired");
  assertEquals(await presenterUnlockId(t.token, "y".repeat(40), now), null, "other secret");
  // A plus_session (same secret, user id) is not an unlock, even with a pr: subject.
  const s = await mintSession(`pr:${ID}`, SECRET, { now });
  assertEquals(await presenterUnlockId(s.token, SECRET, now), null);
  assertEquals(await presenterUnlockId("", SECRET, now), null);
  assertEquals(await presenterUnlockId(t.token, "", now), null, "no secret: locked");
});

Deno.test("presenter code: exact match only; no code set means never", async () => {
  assert(await presenterCodeMatches("plum-tree-42", "plum-tree-42"));
  assert(await presenterCodeMatches(" plum-tree-42 ", "plum-tree-42"));
  assert(!(await presenterCodeMatches("plum-tree-4", "plum-tree-42")));
  assert(!(await presenterCodeMatches("plum-tree-42", "")));
  assert(!(await presenterCodeMatches("short", "short")), "codes under 6 characters are refused");
  assert(!(await presenterCodeMatches(undefined, "plum-tree-42")));
});

Deno.test("client address: Cloudflare's, never the client's first x-forwarded-for entry", () => {
  assertEquals(clientAddress(new Request("http://x", { headers: { "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "1.2.3.4" } })), "9.9.9.9");
  assertEquals(clientAddress(new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } })), "5.6.7.8");
  assertEquals(clientAddress(new Request("http://x")), "unknown");
});
