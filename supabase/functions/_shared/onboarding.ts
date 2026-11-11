// Opening a Plus account: by voice, on screen, or at an agent (Mama Bisi registers a customer on
// her own screen; a kiosk would work the same way). One sign-up, six steps, in this order:
//
//   name -> language -> phone (code) -> PIN -> verification (selfie, then ID) -> wallet
//
// The steps run on an onboarding session (onboarding_sessions), reached with a signed token
// (x-plus-onboarding, or plus_session "ob:<id>" for the voice agent). The users row and the login
// are created when the phone is verified. Rules that keep people safe:
//   * The PIN is typed on the screen keypad only; voice can never set it.
//   * The ID number (NIN) is typed on screen only, never spoken; only an HMAC and the last 4 digits
//     are kept. India never asks for an ID number (no Aadhaar): the partner bank does that check.
//   * The selfie never leaves the phone: the (simulated) liveness check stores a pass flag only.
//   * Phone codes: HMAC stored, 10 minutes, 5 wrong tries. With no SMS provider (testnet), the code
//     is shown on screen as a simulated SMS; the voice agent never sees it.
//   * Signing up again with a test number (market pack demoPhonePrefix) archives the previous test
//     person (history kept) so rehearsals can be re-run; any other number already in use is refused.
import { getMarket, isDemoPhone, type MarketId } from "./markets.ts";
import { tierSummary } from "./tiers.ts";
import type { ToolResult } from "./tools.ts";

export type ObChannel = "app" | "agent" | "voice";

export interface ObSession {
  id: string;
  market_id: MarketId;
  name: string | null;
  language: string | null;
  phone: string | null;
  code_hash: string | null;
  code_expires_at: string | null;
  code_attempts: number;
  codes_sent: number;
  user_id: string | null;
  helper_id: string | null;
  channel: "app" | "agent";
  finished_at: string | null;
  expires_at: string;
}

export interface ObUser {
  id: string;
  market_id: MarketId;
  name: string | null;
  language: string;
  wa_phone: string;
  kyc_tier: number;
  stellar_pub: string | null;
  ref_hash: string | null;
  selfie_passed: boolean;
  id_last4: string | null;
  trusted_contact_phone: string | null;
  trusted_contact_name: string | null;
  virtual_account: string | null;
  member_since: string | null;
  onboarded_via: string | null;
  archived_at: string | null;
}

export interface WalletProgress {
  status: "queued" | "submitted" | "done" | "failed" | "none";
  tx_hash: string | null;
}

export interface OnboardingStore {
  createSession(market: MarketId, helperId: string | null): Promise<ObSession>;
  session(id: string): Promise<ObSession | null>;
  updateSession(id: string, patch: Partial<ObSession>): Promise<ObSession>;
  user(id: string): Promise<ObUser | null>;
  /** The active (not archived) user with this phone. */
  userByPhone(phone: string): Promise<ObUser | null>;
  /** Creates the users row and its login (no password anyone knows; sign-in is phone + PIN). */
  createUser(u: { market: MarketId; phone: string; name: string; language: string; via: "app" | "voice" | "agent"; helperId: string | null }): Promise<ObUser>;
  updateUser(id: string, patch: Partial<ObUser> & { id_hash?: string; phone_verified_at?: string }): Promise<ObUser>;
  /** Archive a test person (history kept, number and login freed). */
  archiveDemoUser(userId: string, prefix: string): Promise<void>;
  hasPin(userId: string): Promise<boolean>;
  setPin(userId: string, pin: string): Promise<void>;
  /** Nigeria: store the key in Vault and queue the sponsored account (ng_create_wallet). Idempotent. */
  createWallet(userId: string): Promise<{ created: boolean; pub: string; virtual_account: string | null }>;
  walletProgress(userId: string): Promise<WalletProgress>;
  /** India: her on-chain record reference and her (simulated) partner bank account. No crypto. */
  openIndiaAccount(userId: string): Promise<void>;
}

export interface ObContext {
  store: OnboardingStore;
  session: ObSession;
  channel: ObChannel;
  args: Record<string, unknown>;
  /** HMAC key for phone codes and ID numbers (Supabase secret PIN_PEPPER). */
  secret: string;
  explorer?: string;
  now?: Date;
}

export type ObTool = (ctx: ObContext) => Promise<ToolResult>;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  pcm: "Pidgin",
  yo: "Yorùbá",
  ha: "Hausa",
  ig: "Igbo",
  ta: "தமிழ் Tamil",
};

/** "0700 000 0101", "+234 700 000 0101", "234700..." (Nigeria) or "70000 00101" (India) -> E.164, or null. */
export function normalizePhone(market: MarketId, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const d = raw.replace(/[\s().-]/g, "");
  let e164: string | null = null;
  if (market === "ng") {
    if (/^\+234\d{10}$/.test(d)) e164 = d;
    else if (/^234\d{10}$/.test(d)) e164 = `+${d}`;
    else if (/^0\d{10}$/.test(d)) e164 = `+234${d.slice(1)}`;
  } else {
    if (/^\+91\d{10}$/.test(d)) e164 = d;
    else if (/^91\d{10}$/.test(d)) e164 = `+${d}`;
    else if (/^0?\d{10}$/.test(d)) e164 = `+91${d.slice(-10)}`;
  }
  return e164 && new RegExp(getMarket(market).onboarding.phonePattern).test(e164) ? e164 : null;
}

/** A name as she gives it: trimmed, single spaces, letters (any script), spaces, ' and - only. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  if (s.length < 2 || s.length > 60) return null;
  return /^[\p{L}\p{M}][\p{L}\p{M} '’-]*$/u.test(s) ? s : null;
}

/** PINs nobody should use: one repeated digit, or a straight run up or down (1234, 9876). */
export function weakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const up = "01234567890123456789";
  const down = "98765432109876543210";
  return up.includes(pin) || down.includes(pin);
}

export function newNumericCode(digits: number): string {
  const max = 10 ** digits;
  const limit = Math.floor(0x1_0000_0000 / max) * max; // rejection sampling: no modulo bias
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % max).padStart(digits, "0");
  }
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  if (!secret) throw new Error("PIN_PEPPER is not set");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const phoneCodeHash = (secret: string, sessionId: string, phone: string, code: string) =>
  hmacHex(secret, `plus-phone-code:v1:${sessionId}:${phone}:${code}`);

/** The only thing kept of an ID number (with its last 4 digits). */
export const idNumberHash = (secret: string, market: MarketId, idNumber: string) => hmacHex(secret, `plus-id-number:v1:${market}:${idNumber}`);

function sameHex(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export type Step = "name" | "language" | "phone" | "pin" | "verify" | "wallet";
export const STEPS: Step[] = ["name", "language", "phone", "pin", "verify", "wallet"];

export interface ObState {
  steps: { step: Step; done: boolean }[];
  current: Step | "done";
  tier: number;
}

/** Where she is: each step done or not, and the first one still to do. */
export function obState(s: ObSession, u: ObUser | null, hasPin: boolean, wallet: WalletProgress): ObState {
  const ng = s.market_id === "ng";
  const done: Record<Step, boolean> = {
    name: Boolean(u?.name ?? s.name),
    language: Boolean(s.language ?? (u ? u.language : null)),
    phone: Boolean(u),
    pin: hasPin,
    verify: (u?.kyc_tier ?? 0) >= 1,
    wallet: ng ? wallet.status === "done" : Boolean(u?.ref_hash),
  };
  const steps = STEPS.map((step) => ({ step, done: done[step] }));
  const first = steps.find((x) => !x.done);
  return { steps, current: first ? first.step : "done", tier: u?.kyc_tier ?? 0 };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function refuse(text: string, error: string, extra: Record<string, unknown> = {}): ToolResult {
  return { text, ok: false, error, ...extra };
}

const NEXT_PROMPT: Record<Step | "done", string> = {
  name: "Ask her name: what should Plus call her?",
  language: "Ask which language she likes best.",
  phone: "Ask for her phone number. A code comes to that phone (on this demo, it shows on the screen).",
  pin: "Ask her to choose a PIN on the screen keypad. Never ask for the PIN out loud.",
  verify: "Next: a quick photo on the screen to check it is really her.",
  wallet: "Last step: open her wallet.",
  done: "Her account is ready.",
};

/** Everything the screen and the voice agent need to show or say where she is. */
async function status(ctx: ObContext, extra: Partial<ToolResult> = {}): Promise<ToolResult> {
  const { store, session: s, explorer } = ctx;
  const u = s.user_id ? await store.user(s.user_id) : null;
  const [hasPin, wallet] = u ? await Promise.all([store.hasPin(u.id), store.walletProgress(u.id)]) : [false, { status: "none", tx_hash: null } as WalletProgress];
  const st = obState(s, u, hasPin, wallet);
  const m = getMarket(s.market_id);
  const tierInfo = u ? tierSummary(u) : tierSummary({ market_id: s.market_id, kyc_tier: 0 });
  return {
    text: extra.text ?? NEXT_PROMPT[st.current],
    ok: extra.ok ?? true,
    ...extra,
    onboarding_id: s.id,
    market: s.market_id,
    channel: s.channel,
    current: st.current,
    steps: st.steps,
    name: u?.name ?? s.name,
    language: s.language ?? u?.language ?? null,
    languages: m.languages.map((code) => ({ code, label: LANGUAGE_NAMES[code] ?? code })),
    phone: u?.wa_phone ?? s.phone,
    phone_hint: m.onboarding.phoneHint,
    code_sent: Boolean(s.code_hash),
    has_pin: hasPin,
    selfie_passed: u?.selfie_passed ?? false,
    id_document: m.kyc.idDocument ? { name: m.kyc.idDocument.name, digits: m.kyc.idDocument.digits } : null,
    id_last4: u?.id_last4 ?? null,
    tier: st.tier,
    limits: tierInfo,
    trusted_contact: u?.trusted_contact_phone ? { name: u.trusted_contact_name, phone: u.trusted_contact_phone } : null,
    wallet: s.market_id === "ng"
      ? {
        status: wallet.status,
        address: u?.stellar_pub ?? null,
        account_url: explorer && u?.stellar_pub ? `${explorer}/account/${u.stellar_pub}` : null,
        tx_url: explorer && wallet.tx_hash ? `${explorer}/tx/${wallet.tx_hash}` : null,
        virtual_account: u?.virtual_account ?? null,
        bank_label: m.virtualAccount?.bankLabel ?? null,
      }
      : { status: u?.ref_hash ? "done" : "none", bank_label: "Partner bank (simulated)" },
    finished: Boolean(s.finished_at),
  };
}

export const obStatus: ObTool = (ctx) => status(ctx);

/** "Pidgin", "yoruba", "Yorùbá", "pcm" -> the market's language code (or undefined). */
export function matchLanguage(langs: string[], said: string): string | undefined {
  const plain = (x: string) => x.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
  const lang = plain(said);
  if (!lang) return undefined;
  return langs.find((l) => l === lang || plain(LANGUAGE_NAMES[l] ?? "") === lang) ??
    langs.find((l) => plain(LANGUAGE_NAMES[l] ?? "").includes(lang) || (lang === "tamil" && l === "ta"));
}

export const obSetProfile: ObTool = async (ctx) => {
  const { store, args } = ctx;
  let s = ctx.session;
  const patch: Partial<ObSession> = {};
  if (args.name !== undefined && args.name !== null && args.name !== "") {
    const name = cleanName(args.name);
    if (!name) return refuse("I didn't catch the name. Ask her to say it again (or type it).", "invalid_name");
    patch.name = name;
  }
  if (args.language !== undefined && args.language !== null && args.language !== "") {
    const plain = (x: string) => x.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const lang = plain(String(args.language));
    const langs = getMarket(s.market_id).languages;
    const code = matchLanguage(langs, String(args.language));
    if (!code) return refuse(`Plus speaks ${langs.map((l) => LANGUAGE_NAMES[l] ?? l).join(", ")}. Ask which one she likes.`, "invalid_language");
    patch.language = code;
  }
  if (Object.keys(patch).length === 0) return refuse("Nothing to save: give a name or a language.", "nothing_to_save");
  s = await store.updateSession(s.id, patch);
  if (s.user_id) {
    await store.updateUser(s.user_id, { ...(patch.name ? { name: patch.name } : {}), ...(patch.language ? { language: patch.language } : {}) });
  }
  return status({ ...ctx, session: s }, { text: `Saved. ${NEXT_PROMPT[patch.language ? "phone" : "language"]}` });
};

export const obSendPhoneCode: ObTool = async (ctx) => {
  const { store, args, channel, secret, now = new Date() } = ctx;
  let s = ctx.session;
  const m = getMarket(s.market_id);
  if (s.user_id) return refuse("Her phone is already checked.", "phone_done");
  if (!s.name) return refuse("First ask her name.", "name_first");
  const phone = normalizePhone(s.market_id, args.phone ?? s.phone);
  if (!phone) return refuse(`That is not a phone number I can use. Ask her to say it again, like ${m.onboarding.phoneHint}.`, "invalid_phone");
  if (s.codes_sent >= m.onboarding.maxCodesPerSession) return refuse("Too many codes for this sign-up. Start again in a little while.", "too_many_codes");
  const existing = await store.userByPhone(phone);
  if (existing && !(isDemoPhone(s.market_id, phone) && existing.onboarded_via)) {
    return refuse("This number already has a Plus account. She can sign in with her number and PIN.", "phone_taken");
  }
  const code = newNumericCode(m.onboarding.phoneCodeDigits);
  s = await store.updateSession(s.id, {
    phone,
    code_hash: await phoneCodeHash(secret, s.id, phone, code),
    code_expires_at: new Date(now.getTime() + m.onboarding.phoneCodeTtlSecs * 1000).toISOString(),
    code_attempts: 0,
    codes_sent: s.codes_sent + 1,
  });
  const minutes = Math.round(m.onboarding.phoneCodeTtlSecs / 60);
  return status({ ...ctx, session: s }, {
    text: `A ${m.onboarding.phoneCodeDigits}-digit code is on its way to ${phone}. On this demo it shows on her screen as a text message. Ask her to read it or type it in. It works for ${minutes} minutes.`,
    // Testnet has no SMS provider: the code is shown on the screen as a simulated SMS. Never to voice.
    demo_sms: channel === "voice" ? undefined : { to: phone, code, text: `Plus: your code is ${code}. It works for ${minutes} minutes. Never share it.` },
    code_expires_at: s.code_expires_at,
  });
};

export const obVerifyPhoneCode: ObTool = async (ctx) => {
  const { store, args, secret, channel, now = new Date() } = ctx;
  let s = ctx.session;
  const m = getMarket(s.market_id);
  if (s.user_id) return status(ctx, { text: "Her phone is already checked." });
  if (!s.phone || !s.code_hash || !s.code_expires_at) return refuse("Send her a code first.", "no_code");
  if (s.code_attempts >= m.onboarding.maxCodeAttempts) return refuse("Too many wrong codes. Send a new code.", "too_many_attempts");
  if (new Date(s.code_expires_at).getTime() <= now.getTime()) return refuse("That code has expired. Send a new one.", "code_expired");
  const code = String(args.code ?? "").replace(/\D/g, "");
  const ok = code.length === m.onboarding.phoneCodeDigits && sameHex(await phoneCodeHash(secret, s.id, s.phone, code), s.code_hash);
  if (!ok) {
    s = await store.updateSession(s.id, { code_attempts: s.code_attempts + 1 });
    const left = m.onboarding.maxCodeAttempts - s.code_attempts;
    return refuse(left > 0 ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Send a new code.", "wrong_code", { attempts_left: left });
  }
  // Re-running a sign-up with a test number: archive the earlier test person (never delete).
  const existing = await store.userByPhone(s.phone);
  if (existing) {
    if (!(isDemoPhone(s.market_id, s.phone) && existing.onboarded_via)) {
      return refuse("This number already has a Plus account. She can sign in with her number and PIN.", "phone_taken");
    }
    await store.archiveDemoUser(existing.id, m.onboarding.demoPhonePrefix);
  }
  const user = await store.createUser({
    market: s.market_id,
    phone: s.phone,
    name: s.name ?? "",
    language: s.language ?? m.languages[0],
    via: s.channel === "agent" ? "agent" : channel === "voice" ? "voice" : "app",
    helperId: s.helper_id,
  });
  await store.updateUser(user.id, { phone_verified_at: now.toISOString() });
  s = await store.updateSession(s.id, { user_id: user.id, code_hash: null, code_expires_at: null });
  return status({ ...ctx, session: s }, { text: `Phone checked. ${NEXT_PROMPT.pin}` });
};

export const obSetPin: ObTool = async (ctx) => {
  const { store, args, channel, session: s } = ctx;
  if (channel === "voice") return refuse("The PIN is set on the screen keypad only. Ask her to type it there; never say it out loud.", "pin_on_screen_only");
  if (!s.user_id) return refuse("Check her phone first.", "phone_first");
  const pin = typeof args.pin === "string" ? args.pin : "";
  if (!/^[0-9]{4,6}$/.test(pin)) return refuse("The PIN is 4 to 6 numbers.", "invalid_pin");
  if (weakPin(pin)) return refuse("That PIN is too easy to guess. Choose numbers that are not all the same or in a row.", "weak_pin");
  await store.setPin(s.user_id, pin);
  return status(ctx, { text: `PIN saved. ${NEXT_PROMPT.verify}` });
};

export const obVerifyIdentity: ObTool = async (ctx) => {
  const { store, args, channel, secret, session: s } = ctx;
  if (!s.user_id) return refuse("Check her phone first.", "phone_first");
  let u = await store.user(s.user_id);
  if (!u) return refuse("I couldn't find her sign-up. Start again.", "not_found");
  const m = getMarket(s.market_id);
  const doc = m.kyc.idDocument;
  const wantsSelfie = args.selfie === "passed" || args.selfie === true;
  const idNumber = typeof args.id_number === "string" ? args.id_number.replace(/\s/g, "") : typeof args.nin === "string" ? args.nin.replace(/\s/g, "") : "";

  if (wantsSelfie) {
    if (channel === "voice") return refuse("The photo is taken on the screen. Ask her to look at the camera on her screen.", "selfie_on_screen_only");
    // The photo never leaves her phone; the liveness check is simulated and only its pass is kept.
    u = await store.updateUser(u.id, { selfie_passed: true, kyc_tier: Math.max(u.kyc_tier, 1) });
  }
  if (idNumber) {
    if (channel === "voice") return refuse(`Never take the ${doc?.name ?? "ID number"} by voice. Ask her to type it on her screen.`, "id_on_screen_only");
    if (!doc) return refuse("Plus never asks for an ID number here. Her bank checks her ID; no Aadhaar is ever needed.", "not_in_market");
    if (!u.selfie_passed) return refuse("First the photo, then the ID number.", "selfie_first");
    if (!new RegExp(`^\\d{${doc.digits}}$`).test(idNumber)) return refuse(`A ${doc.name} is ${doc.digits} numbers. Ask her to check it.`, "invalid_id_number");
    // Mock registry: every well-formed number is found, except the test "wrong" number.
    if (idNumber === doc.wrongTestNumber) {
      return refuse(`The ${doc.name} registry did not find that number. Nothing was saved. Ask her to check it and type it again.`, "id_not_found");
    }
    u = await store.updateUser(u.id, { id_hash: await idNumberHash(secret, s.market_id, idNumber), id_last4: idNumber.slice(-4), kyc_tier: 2 });
  }
  if (!wantsSelfie && !idNumber) {
    return status(ctx, {
      text: u.selfie_passed
        ? doc ? `Photo done. She can also type her ${doc.name} on the screen for higher limits${getMarket(s.market_id).lending ? ", and it counts toward a loan" : " and advances"}; never say it out loud.` : "Photo done."
        : "Ask her to take a quick photo on her screen.",
      ok: false,
      error: "nothing_given",
    });
  }
  const t = tierSummary(u);
  return status(ctx, {
    text: u.kyc_tier >= 2
      ? `${doc?.name ?? "ID"} checked. She can send up to ${t.daily_text} a day and hold up to ${t.balance_text}. ${m.lending ? `A loan can open after ${m.lending.unlock.weeks} weeks with Plus.` : `Advances open after ${m.advance.eligibleAfterWeeks} weeks.`}`
      : `Photo checked. For now she can send up to ${t.daily_text} a day and hold up to ${t.balance_text}.` +
        (doc ? ` Adding her ${doc.name} raises that and ${getMarket(s.market_id).lending ? "counts toward a loan" : "opens advances"}.` : ""),
  });
};

export const obCreateWallet: ObTool = async (ctx) => {
  const { store, session: s, explorer } = ctx;
  if (!s.user_id) return refuse("Check her phone first.", "phone_first");
  const u = await store.user(s.user_id);
  if (!u) return refuse("I couldn't find her sign-up. Start again.", "not_found");
  if (!(await store.hasPin(u.id))) return refuse("She needs a PIN first. Ask her to choose one on the screen.", "pin_first");
  if (u.kyc_tier < 1) return refuse("First the photo check on her screen.", "verify_first");
  if (s.market_id === "in") {
    await store.openIndiaAccount(u.id);
    return status(ctx, { text: "Her Plus account is ready, with her (simulated) partner bank account. She holds rupees in the bank; nothing in crypto." });
  }
  const w = await store.createWallet(u.id);
  return status(ctx, {
    text: w.created
      ? "Opening her wallet on Stellar now. It takes a few seconds; her screen shows the tick when it is ready."
      : "Her wallet is already being opened.",
    wallet_address: w.pub,
    account_url: explorer ? `${explorer}/account/${w.pub}` : null,
  });
};

export const obSetTrustedContact: ObTool = async (ctx) => {
  const { store, args, session: s } = ctx;
  if (!s.user_id) return refuse("Check her phone first.", "phone_first");
  const u = await store.user(s.user_id);
  if (!u) return refuse("I couldn't find her sign-up.", "not_found");
  const phone = normalizePhone(s.market_id, args.phone);
  if (!phone) return refuse("That is not a phone number I can use. Ask again.", "invalid_phone");
  if (phone === u.wa_phone) return refuse("That is her own number. Ask for someone she trusts.", "own_number");
  const name = args.name ? cleanName(args.name) : null;
  if (args.name && !name) return refuse("I didn't catch that name.", "invalid_name");
  await store.updateUser(u.id, { trusted_contact_phone: phone, trusted_contact_name: name });
  return status(ctx, { text: `Saved ${name ?? "that person"} as her trusted contact. Plus only calls them if she asks, or if she can't get into her account.` });
};

/** All done: the session closes. The app then signs her in (finishOnboarding in agent-tools). */
export async function finishCheck(ctx: ObContext): Promise<ToolResult | null> {
  const r = await status(ctx);
  if (r.current !== "done") return refuse(`Not finished yet: ${String(r.current)} is next.`, "not_finished", { current: r.current });
  return null;
}

export const OB_TOOLS: Record<string, ObTool> = {
  start_onboarding: obStatus,
  onboarding_status: obStatus,
  set_profile: obSetProfile,
  send_phone_code: obSendPhoneCode,
  verify_phone_code: obVerifyPhoneCode,
  set_pin: obSetPin,
  verify_identity: obVerifyIdentity,
  create_wallet: obCreateWallet,
  set_trusted_contact: obSetTrustedContact,
};
