import { assert, assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert@1";
import {
  cleanName,
  idNumberHash,
  normalizePhone,
  type ObChannel,
  type ObSession,
  type ObUser,
  obCreateWallet,
  obSendPhoneCode,
  obSetPin,
  obSetProfile,
  obSetTrustedContact,
  obStatus,
  obVerifyIdentity,
  obVerifyPhoneCode,
  type OnboardingStore,
  weakPin,
} from "./onboarding.ts";
import { advanceAllowed, receiveAllowed, spendAllowed } from "./tiers.ts";

const SECRET = "test-pepper-0123456789abcdef0123456789abcdef";
const N = (naira: number) => BigInt(naira) * 100n;

type World = {
  sessions: Map<string, ObSession>;
  users: Map<string, ObUser & { id_hash?: string }>;
  pins: Map<string, string>;
  archived: string[];
  wallets: Map<string, { pub: string; status: "queued" | "done" }>;
  india: string[];
};

function fakeStore(w: World): OnboardingStore {
  let n = 0;
  return {
    createSession: (market, helperId) => {
      const s: ObSession = {
        id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
        market_id: market,
        name: null,
        language: null,
        phone: null,
        code_hash: null,
        code_expires_at: null,
        code_attempts: 0,
        codes_sent: 0,
        user_id: null,
        helper_id: helperId,
        channel: helperId ? "agent" : "app",
        finished_at: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      };
      w.sessions.set(s.id, s);
      return Promise.resolve(s);
    },
    session: (id) => Promise.resolve(w.sessions.get(id) ?? null),
    updateSession: (id, patch) => {
      const s = { ...w.sessions.get(id)!, ...patch };
      w.sessions.set(id, s);
      return Promise.resolve(s);
    },
    user: (id) => Promise.resolve(w.users.get(id) ?? null),
    userByPhone: (phone) => Promise.resolve([...w.users.values()].find((u) => u.wa_phone === phone && !u.archived_at) ?? null),
    createUser: (u) => {
      const user: ObUser = {
        id: `user-${w.users.size + 1}`,
        market_id: u.market,
        name: u.name,
        language: u.language,
        wa_phone: u.phone,
        kyc_tier: 0,
        stellar_pub: null,
        ref_hash: null,
        selfie_passed: false,
        id_last4: null,
        trusted_contact_phone: null,
        trusted_contact_name: null,
        virtual_account: null,
        member_since: new Date().toISOString(),
        onboarded_via: u.via,
        archived_at: null,
      };
      w.users.set(user.id, user);
      return Promise.resolve(user);
    },
    updateUser: (id, patch) => {
      const u = { ...w.users.get(id)!, ...patch };
      w.users.set(id, u);
      return Promise.resolve(u);
    },
    archiveDemoUser: (id) => {
      w.archived.push(id);
      w.users.set(id, { ...w.users.get(id)!, archived_at: new Date().toISOString(), wa_phone: "+990000000000001" });
      return Promise.resolve();
    },
    hasPin: (id) => Promise.resolve(w.pins.has(id)),
    setPin: (id, pin) => {
      w.pins.set(id, pin);
      return Promise.resolve();
    },
    createWallet: (id) => {
      const had = w.wallets.get(id);
      if (had) return Promise.resolve({ created: false, pub: had.pub, virtual_account: "9000010002" });
      const pub = "G" + "A".repeat(55);
      w.wallets.set(id, { pub, status: "queued" });
      w.users.set(id, { ...w.users.get(id)!, stellar_pub: pub, virtual_account: "9000010002" });
      return Promise.resolve({ created: true, pub, virtual_account: "9000010002" });
    },
    walletProgress: (id) => Promise.resolve(w.wallets.has(id) ? { status: w.wallets.get(id)!.status, tx_hash: w.wallets.get(id)!.status === "done" ? "ab".repeat(32) : null } : { status: "none", tx_hash: null }),
    openIndiaAccount: (id) => {
      w.india.push(id);
      w.users.set(id, { ...w.users.get(id)!, ref_hash: "cd".repeat(32) });
      return Promise.resolve();
    },
  };
}

async function setup(market: "ng" | "in" = "ng") {
  const w: World = { sessions: new Map(), users: new Map(), pins: new Map(), archived: [], wallets: new Map(), india: [] };
  const store = fakeStore(w);
  const s = await store.createSession(market, null);
  const ctx = (args: Record<string, unknown> = {}, channel: ObChannel = "app", now?: Date) => ({
    store,
    session: w.sessions.get(s.id)!,
    channel,
    args,
    secret: SECRET,
    explorer: "https://stellar.expert/explorer/testnet",
    now,
  });
  return { w, store, ctx, id: s.id };
}

/** Name, language, phone (with the code from the simulated SMS). */
async function throughPhone(t: Awaited<ReturnType<typeof setup>>, phone = "0700 000 0101") {
  await obSetProfile(t.ctx({ name: "Adaeze Okafor", language: "pidgin" }));
  const sent = await obSendPhoneCode(t.ctx({ phone }));
  const sms = sent.demo_sms as { code: string };
  return await obVerifyPhoneCode(t.ctx({ code: sms.code }));
}

// --- small rules --------------------------------------------------------------------------------------

Deno.test("phone numbers: Nigerian and Indian forms to E.164; anything else refused", () => {
  assertEquals(normalizePhone("ng", "0700 000 0101"), "+2347000000101");
  assertEquals(normalizePhone("ng", "+234 803 555 0101"), "+2348035550101");
  assertEquals(normalizePhone("ng", "2348035550101"), "+2348035550101");
  assertEquals(normalizePhone("ng", "0803"), null);
  assertEquals(normalizePhone("in", "70000 00101"), "+917000000101");
  assertEquals(normalizePhone("in", "+1 548 328 1234"), null);
});

Deno.test("names: letters in any script; PINs: no repeats or straight runs", () => {
  assertEquals(cleanName("  adaeze   okafor "), "adaeze okafor");
  assertEquals(cleanName("Fúnmiláyọ̀"), "Fúnmiláyọ̀");
  assertEquals(cleanName("செல்வி"), "செல்வி");
  assertEquals(cleanName("x"), null);
  assertEquals(cleanName("<script>"), null);
  for (const p of ["1111", "1234", "4321", "123456", "987654", "0000"]) assert(weakPin(p), p);
  for (const p of ["2580", "1357", "8462"]) assert(!weakPin(p), p);
});

// --- the steps -----------------------------------------------------------------------------------------

Deno.test("sign-up runs in order: name, language, phone, PIN, verification, wallet", async () => {
  const t = await setup();
  assertEquals((await obStatus(t.ctx())).current, "name");
  assertEquals((await obSendPhoneCode(t.ctx({ phone: "07000000101" }))).error, "name_first");
  await obSetProfile(t.ctx({ name: "Adaeze" }));
  assertEquals((await obStatus(t.ctx())).current, "language");
  const lang = await obSetProfile(t.ctx({ language: "Yoruba" }));
  assertEquals(lang.language, "yo");
  assertEquals(lang.current, "phone");
  const r = await obVerifyPhoneCode(t.ctx({ code: "123456" }));
  assertEquals(r.error, "no_code");
  const sent = await obSendPhoneCode(t.ctx({ phone: "0700 000 0101" }));
  const ok = await obVerifyPhoneCode(t.ctx({ code: (sent.demo_sms as { code: string }).code }));
  assertEquals(ok.current, "pin");
  assertEquals((await obCreateWallet(t.ctx())).error, "pin_first");
  await obSetPin(t.ctx({ pin: "2580" }));
  assertEquals((await obStatus(t.ctx())).current, "verify");
  assertEquals((await obCreateWallet(t.ctx())).error, "verify_first");
  await obVerifyIdentity(t.ctx({ selfie: "passed" }));
  assertEquals((await obStatus(t.ctx())).current, "wallet");
});

Deno.test("phone code: shown on screen as a simulated SMS, never given to voice", async () => {
  const t = await setup();
  await obSetProfile(t.ctx({ name: "Adaeze", language: "en" }));
  const voice = await obSendPhoneCode(t.ctx({ phone: "07000000101" }, "voice"));
  assertEquals(voice.ok, true);
  assertEquals(voice.demo_sms, undefined);
  assert(!JSON.stringify(voice).includes("demo_sms"));
  const app = await obSendPhoneCode(t.ctx({ phone: "07000000101" }));
  const sms = app.demo_sms as { to: string; code: string; text: string };
  assertEquals(sms.to, "+2347000000101");
  assertMatch(sms.code, /^\d{6}$/);
  // Only an HMAC of the code is stored, bound to this sign-up and number.
  const s = t.w.sessions.get(t.id)!;
  assertMatch(String(s.code_hash), /^[0-9a-f]{64}$/);
  assert(!String(s.code_hash).includes(sms.code));
});

Deno.test("phone code expiry: refused after 10 minutes, and after 5 wrong tries", async () => {
  const t = await setup();
  await obSetProfile(t.ctx({ name: "Adaeze", language: "en" }));
  const sent = await obSendPhoneCode(t.ctx({ phone: "07000000101" }));
  const code = (sent.demo_sms as { code: string }).code;
  const later = new Date(Date.now() + 10 * 60_000 + 1000);
  const expired = await obVerifyPhoneCode(t.ctx({ code }, "app", later));
  assertEquals(expired.error, "code_expired");
  assertEquals(t.w.users.size, 0);
  // A fresh code works within the time; 5 wrong tries lock that code.
  const again = await obSendPhoneCode(t.ctx({ phone: "07000000101" }));
  const good = (again.demo_sms as { code: string }).code;
  const wrong = good === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) {
    const r = await obVerifyPhoneCode(t.ctx({ code: wrong }));
    assertEquals(r.error, "wrong_code");
  }
  assertEquals((await obVerifyPhoneCode(t.ctx({ code: good }))).error, "too_many_attempts");
});

Deno.test("PIN: set on the screen keypad only; voice can never set it; easy PINs refused", async () => {
  const t = await setup();
  await throughPhone(t);
  assertEquals((await obSetPin(t.ctx({ pin: "2580" }, "voice"))).error, "pin_on_screen_only");
  assertEquals((await obSetPin(t.ctx({ pin: "1234" }))).error, "weak_pin");
  assertEquals((await obSetPin(t.ctx({ pin: "12" }))).error, "invalid_pin");
  assertEquals((await obSetPin(t.ctx({ pin: "2580" }))).ok, true);
  assertEquals(t.w.pins.get("user-1"), "2580");
});

Deno.test("verification: selfie gives tier 1; a NIN typed on screen gives tier 2; only a hash and last 4 kept", async () => {
  const t = await setup();
  await throughPhone(t);
  await obSetPin(t.ctx({ pin: "2580" }));
  assertEquals((await obVerifyIdentity(t.ctx({ nin: "12345678901" }))).error, "selfie_first");
  const selfie = await obVerifyIdentity(t.ctx({ selfie: "passed" }));
  assertEquals(selfie.tier, 1);
  assertMatch(selfie.text, /₦50,000 a day/);
  const nin = await obVerifyIdentity(t.ctx({ nin: "1234 5678 901" }));
  assertEquals(nin.tier, 2);
  const u = t.w.users.get("user-1")!;
  assertEquals(u.id_last4, "8901");
  assertEquals(u.id_hash, await idNumberHash(SECRET, "ng", "12345678901"));
  assert(!JSON.stringify(u).includes("12345678901"));
});

Deno.test("wrong NIN: the mock registry refuses the test number and nothing is saved", async () => {
  const t = await setup();
  await throughPhone(t);
  await obVerifyIdentity(t.ctx({ selfie: "passed" }));
  const r = await obVerifyIdentity(t.ctx({ nin: "00000000000" }));
  assertEquals(r.error, "id_not_found");
  assertMatch(r.text, /registry did not find/);
  const u = t.w.users.get("user-1")!;
  assertEquals(u.kyc_tier, 1);
  assertEquals(u.id_last4, null);
  assertEquals((await obVerifyIdentity(t.ctx({ nin: "123" }))).error, "invalid_id_number");
});

Deno.test("the NIN and the selfie are never taken by voice", async () => {
  const t = await setup();
  await throughPhone(t);
  assertEquals((await obVerifyIdentity(t.ctx({ selfie: "passed" }, "voice"))).error, "selfie_on_screen_only");
  await obVerifyIdentity(t.ctx({ selfie: "passed" }));
  const r = await obVerifyIdentity(t.ctx({ nin: "12345678901" }, "voice"));
  assertEquals(r.error, "id_on_screen_only");
  assertMatch(r.text, /type it on her screen/);
  assertEquals(t.w.users.get("user-1")!.kyc_tier, 1);
});

Deno.test("wallet creation: once only, Stellar Expert link, account number for bank transfers", async () => {
  const t = await setup();
  await throughPhone(t);
  await obSetPin(t.ctx({ pin: "2580" }));
  await obVerifyIdentity(t.ctx({ selfie: "passed" }));
  const r = await obCreateWallet(t.ctx());
  assertEquals(r.ok, true);
  assertMatch(String(r.account_url), /stellar\.expert\/explorer\/testnet\/account\/G/);
  assertEquals((r.wallet as { virtual_account: string }).virtual_account, "9000010002");
  assertEquals((r.wallet as { status: string }).status, "queued");
  assertEquals(r.current, "wallet"); // the tick waits for Stellar
  const again = await obCreateWallet(t.ctx());
  assertMatch(again.text, /already being opened/);
  assertEquals(t.w.wallets.size, 1);
  t.w.wallets.get("user-1")!.status = "done";
  const done = await obStatus(t.ctx());
  assertEquals(done.current, "done");
  assertMatch(String((done.wallet as { tx_url: string }).tx_url), /\/tx\//);
});

Deno.test("a test number can sign up again (the earlier test person is archived); a real number in use cannot", async () => {
  const t = await setup();
  await throughPhone(t, "07000000101");
  const t2 = await setup();
  t2.w.users = t.w.users; // same database
  const second = await throughPhone(t2, "07000000101");
  assertEquals(second.ok, true);
  assertEquals(t2.w.archived, ["user-1"]);
  assertNotEquals(second.phone, null);

  const t3 = await setup();
  t3.w.users.set("funmi", { ...t.w.users.get("user-1")!, id: "funmi", wa_phone: "+2348035550101", onboarded_via: null, archived_at: null });
  await obSetProfile(t3.ctx({ name: "Someone", language: "en" }));
  const taken = await obSendPhoneCode(t3.ctx({ phone: "08035550101" }));
  assertEquals(taken.error, "phone_taken");
});

Deno.test("trusted contact: someone else's number, saved with a name", async () => {
  const t = await setup();
  await throughPhone(t);
  assertEquals((await obSetTrustedContact(t.ctx({ phone: "07000000101" }))).error, "own_number");
  const r = await obSetTrustedContact(t.ctx({ phone: "0803 555 0199", name: "Chidi" }));
  assertEquals(r.ok, true);
  assertEquals(t.w.users.get("user-1")!.trusted_contact_phone, "+2348035550199");
});

Deno.test("India: no ID number is ever asked (no Aadhaar); the account is a bank account, no crypto", async () => {
  const t = await setup("in");
  await obSetProfile(t.ctx({ name: "Meena", language: "ta" }));
  const sent = await obSendPhoneCode(t.ctx({ phone: "70000 00101" }));
  await obVerifyPhoneCode(t.ctx({ code: (sent.demo_sms as { code: string }).code }));
  await obSetPin(t.ctx({ pin: "2580" }));
  await obVerifyIdentity(t.ctx({ selfie: "passed" }));
  const id = await obVerifyIdentity(t.ctx({ id_number: "123412341234" }));
  assertEquals(id.error, "not_in_market");
  const w = await obCreateWallet(t.ctx());
  assertEquals(w.ok, true);
  assertEquals(t.w.india, ["user-1"]);
  assertEquals(t.w.users.get("user-1")!.stellar_pub, null);
  assertEquals((await obStatus(t.ctx())).current, "done");
});

// --- tier rules -------------------------------------------------------------------------------------------

Deno.test("tiers: daily and balance limits per tier; advances need tier 2 and 8 weeks", () => {
  const t1 = { market_id: "ng" as const, kyc_tier: 1 };
  const t2 = { market_id: "ng" as const, kyc_tier: 2, member_since: "2026-01-01T00:00:00Z" };
  assertEquals(spendAllowed({ ...t1, kyc_tier: 0 }, N(1), 0n)?.error, "signup_not_finished");
  assertEquals(spendAllowed(t1, N(50_000), 0n), null);
  assertEquals(spendAllowed(t1, N(1), N(50_000))?.error, "daily_limit");
  assertEquals(spendAllowed(t2, N(200_000), 0n), null);
  assertEquals(receiveAllowed(t1, N(299_000), N(1_000)), null);
  assertEquals(receiveAllowed(t1, N(299_000), N(1_001))?.error, "balance_limit");
  assertEquals(receiveAllowed(t2, N(499_000), N(1_000)), null);
  assertEquals(advanceAllowed(t1)?.error, "tier_too_low");
  assertEquals(advanceAllowed(t2, new Date("2026-02-01T00:00:00Z"))?.error, "too_new");
  assertEquals(advanceAllowed(t2, new Date("2026-03-01T00:00:00Z")), null);
  // India: the partner bank's tiers; tier 1 is a small wallet.
  assertEquals(spendAllowed({ market_id: "in", kyc_tier: 1 }, N(5_001), 0n)?.error, "daily_limit");
});
