import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { hasSessionToken, mintSession, SESSION_TTL_SECS, verifySession } from "./session.ts";

const SECRET = "s".repeat(64);
const USER = "6f1c2a7e-0000-4000-8000-000000000001";

Deno.test("session: a fresh token verifies and names the user", async () => {
  const { token, expiresAt } = await mintSession(USER, SECRET, { now: 1_000 });
  assertEquals(expiresAt, 1_000 + SESSION_TTL_SECS);
  assertEquals(SESSION_TTL_SECS, 900);
  const r = await verifySession(token, SECRET, 1_000 + 899);
  assert(r.ok);
  assertEquals(r.userId, USER);
});

Deno.test("session: expired after 15 minutes", async () => {
  const { token } = await mintSession(USER, SECRET, { now: 1_000 });
  assertEquals(await verifySession(token, SECRET, 1_000 + 900), { ok: false, error: "expired" });
});

Deno.test("session: wrong secret, tampered payload or signature is invalid", async () => {
  const { token } = await mintSession(USER, SECRET, { now: 1_000 });
  assertEquals((await verifySession(token, "t".repeat(64), 1_001)).ok, false);

  const [payload, sig] = token.split(".");
  const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  claims.sub = "someone-else";
  const forged = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assertEquals(await verifySession(`${forged}.${sig}`, SECRET, 1_001), { ok: false, error: "invalid" });

  const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
  assertEquals(await verifySession(`${payload}.${flipped}`, SECRET, 1_001), { ok: false, error: "invalid" });
});

Deno.test("session: garbage is invalid, never a crash", async () => {
  for (const bad of [undefined, 42, "", "abc", "a.b.c", "!!!.???", "x".repeat(600)]) {
    assertEquals((await verifySession(bad, SECRET)).ok, false, String(bad));
  }
});

Deno.test("session: fails closed without a secret", async () => {
  await assertRejects(() => mintSession(USER, ""));
  await assertRejects(() => mintSession(USER, "short"));
});

Deno.test("session: empty or placeholder values mean no token", () => {
  assertEquals(hasSessionToken(""), false);
  assertEquals(hasSessionToken("none"), false);
  assertEquals(hasSessionToken("{{plus_session}}"), false);
  assertEquals(hasSessionToken(undefined), false);
  assertEquals(hasSessionToken("abc.def"), true);
});
