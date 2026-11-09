// deno test supabase/functions/_shared/pin.test.ts
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import { checkPin, hashPin, isValidPin, LOCK_MS, newPinCredential, type PinCredential } from "./pin.ts";

const PEPPER = "test-pepper-not-a-secret";
const NOW = new Date("2026-11-09T10:00:00Z");

async function cred(pin = "4821"): Promise<PinCredential> {
  return { ...(await newPinCredential(pin, PEPPER)) };
}

Deno.test("PIN format: 4 to 6 digits only", () => {
  assert(isValidPin("1234"));
  assert(isValidPin("123456"));
  assert(!isValidPin("123"));
  assert(!isValidPin("1234567"));
  assert(!isValidPin("12a4"));
  assert(!isValidPin(" 1234"));
});

Deno.test("hash is HMAC-SHA256(pepper, salt || pin), salted and peppered", async () => {
  const salt = "00112233445566778899aabbccddeeff";
  const h = await hashPin("4821", salt, PEPPER);
  assertEquals(h.length, 64);
  assertEquals(h, await hashPin("4821", salt, PEPPER));
  assertNotEquals(h, await hashPin("4821", "ffeeddccbbaa99887766554433221100", PEPPER));
  assertNotEquals(h, await hashPin("4821", salt, "other-pepper"));

  // Known answer, independent of pin.ts: HMAC over the raw salt bytes followed by the PIN.
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(PEPPER), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const msg = new Uint8Array([...salt.match(/../g)!.map((x) => parseInt(x, 16)), ...new TextEncoder().encode("4821")]);
  const expected = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, msg)), (b) => b.toString(16).padStart(2, "0")).join("");
  assertEquals(h, expected);
});

Deno.test("new credentials get a fresh 16-byte salt and never contain the PIN", async () => {
  const a = await newPinCredential("4821", PEPPER);
  const b = await newPinCredential("4821", PEPPER);
  assertEquals(a.pin_salt.length, 32);
  assertNotEquals(a.pin_salt, b.pin_salt);
  assertNotEquals(a.pin_hash, b.pin_hash);
  assert(!JSON.stringify(a).includes("4821"));
  await assertRejects(() => newPinCredential("12", PEPPER));
});

Deno.test("correct PIN passes without writing when there are no failures", async () => {
  const c = await cred();
  const { result, update } = await checkPin(c, "4821", NOW, PEPPER);
  assertEquals(result, { ok: true, outcome: "ok" });
  assertEquals(update, null);
});

Deno.test("wrong PINs count down, and the third locks for 15 minutes", async () => {
  let c = await cred();
  let r = await checkPin(c, "0000", NOW, PEPPER);
  assertEquals(r.result, { ok: false, outcome: "wrong", attemptsLeft: 2 });
  c = { ...c, ...r.update! };

  r = await checkPin(c, "1111", NOW, PEPPER);
  assertEquals(r.result, { ok: false, outcome: "wrong", attemptsLeft: 1 });
  c = { ...c, ...r.update! };

  r = await checkPin(c, "2222", NOW, PEPPER);
  const until = new Date(NOW.getTime() + LOCK_MS).toISOString();
  assertEquals(r.result, { ok: false, outcome: "locked", lockedUntil: until });
  c = { ...c, ...r.update! };
  assertEquals(c.locked_until, until);

  // While locked, even the right PIN is refused and nothing changes.
  const during = new Date(NOW.getTime() + LOCK_MS - 1000);
  r = await checkPin(c, "4821", during, PEPPER);
  assertEquals(r.result.outcome, "locked");
  assertEquals(r.update, null);

  // After the lock, the right PIN works and clears the lock.
  const after = new Date(NOW.getTime() + LOCK_MS + 1000);
  r = await checkPin(c, "4821", after, PEPPER);
  assertEquals(r.result, { ok: true, outcome: "ok" });
  assertEquals(r.update, { failed_attempts: 0, locked_until: null });
});

Deno.test("an expired lock starts a fresh count of 3", async () => {
  const c = { ...(await cred()), failed_attempts: 0, locked_until: new Date(NOW.getTime() - 1).toISOString() };
  const r = await checkPin(c, "0000", NOW, PEPPER);
  assertEquals(r.result, { ok: false, outcome: "wrong", attemptsLeft: 2 });
});

Deno.test("a correct PIN resets earlier failures", async () => {
  const c = { ...(await cred()), failed_attempts: 2 };
  const r = await checkPin(c, "4821", NOW, PEPPER);
  assertEquals(r.result.outcome, "ok");
  assertEquals(r.update, { failed_attempts: 0, locked_until: null });
});

Deno.test("a malformed PIN counts as a failed attempt", async () => {
  const r = await checkPin(await cred(), "48 21", NOW, PEPPER);
  assertEquals(r.result, { ok: false, outcome: "wrong", attemptsLeft: 2 });
});

Deno.test("missing PIN_PEPPER fails closed", async () => {
  await assertRejects(() => hashPin("4821", "00112233445566778899aabbccddeeff"), Error, "PIN_PEPPER is not set");
});
