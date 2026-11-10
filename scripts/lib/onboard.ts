// A scripted sign-up through the real Edge Functions, exactly as the app does it (agent-tools
// onboarding tools with the signed onboarding token). Used by `pnpm demo:new-user` and `pnpm e2e:ng`.
// Testnet only: the phone code comes back as the simulated SMS the app shows on screen.
import { createClient } from "@supabase/supabase-js";

// deno-lint-ignore no-explicit-any
export type Json = Record<string, any>;

export interface SignUp {
  name: string;
  language: string; // en (Pidgin) | yo | ha | ig
  phone: string; // a test number (+234 700 000 0xxx) can be re-run safely
  pin: string;
  /** 11 digits for tier 2; omit for tier 1 (name, phone, selfie). */
  nin?: string;
  trusted?: { name: string; phone: string };
  /** First type the mock registry's "wrong" NIN and check it is refused (e2e). */
  tryWrongNin?: boolean;
}

export interface SignedUp {
  userId: string;
  phone: string;
  wallet: string;
  walletTx: string | null;
  virtualAccount: string | null;
  tier: number;
  accessToken: string;
  steps: { step: string; ms: number }[];
  walletMs: number;
}

export function plusFetch(url: string) {
  return async (path: string, body: Json = {}, token?: string): Promise<Json & { ms: number; http: number }> => {
    const t0 = Date.now();
    const r = await fetch(`${url}/functions/v1/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({})) as Json;
    return { ...j, http: r.status, ms: Date.now() - t0 };
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A 4-digit PIN that is not weak (no repeats, no straight runs). */
export function testPin(): string {
  for (;;) {
    const p = String(1000 + Math.floor(Math.random() * 9000));
    if (/^(\d)\1+$/.test(p) || "0123456789".includes(p) || "9876543210".includes(p)) continue;
    return p;
  }
}

/** Any 11 digits pass the mock NIN registry except the test "wrong" number 00000000000. */
export const testNin = () => String(Math.floor(1e10 + Math.random() * 8.9e10)).padStart(11, "1");

export async function signUp(url: string, anonKey: string, s: SignUp, log: (line: string) => void = () => {}): Promise<SignedUp> {
  const call = plusFetch(url);
  const steps: { step: string; ms: number }[] = [];
  const must = (r: Json, what: string) => {
    if (r.ok === false || r.error) throw new Error(`${what}: ${r.error} ${r.text ?? ""}`);
    steps.push({ step: what, ms: r.ms });
    log(`  ✓ ${what.padEnd(22)} ${String(r.ms).padStart(5)} ms  ${String(r.text ?? "").slice(0, 110)}`);
    return r;
  };
  const start = must(await call("agent-tools/start_onboarding", { market: "ng" }), "start_onboarding");
  const token = start.onboarding_token as string;
  const t = (tool: string, body: Json = {}) => call(`agent-tools/${tool}`, { ...body, onboarding_token: token });

  must(await t("set_profile", { name: s.name }), "name");
  must(await t("set_profile", { language: s.language }), "language");
  const sent = must(await t("send_phone_code", { phone: s.phone }), "send_phone_code");
  must(await t("verify_phone_code", { code: sent.demo_sms.code }), "verify_phone_code");
  must(await t("set_pin", { pin: s.pin }), "PIN (screen keypad)");
  must(await t("verify_identity", { selfie: "passed" }), "selfie (tier 1)");
  if (s.tryWrongNin) {
    const wrong = await t("verify_identity", { nin: "00000000000" });
    if (wrong.error !== "id_not_found") throw new Error(`wrong NIN was not refused: ${JSON.stringify(wrong)}`);
    log(`  ✓ wrong NIN refused      ${String(wrong.ms).padStart(5)} ms  ${wrong.text}`);
  }
  if (s.nin) must(await t("verify_identity", { nin: s.nin }), "NIN (tier 2)");
  if (s.trusted) must(await t("set_trusted_contact", s.trusted), "trusted contact");

  const t0 = Date.now();
  const w = must(await t("create_wallet"), "create_wallet");
  let st: Json = w;
  while (st.wallet?.status !== "done") {
    if (Date.now() - t0 > 120_000) throw new Error(`wallet not on Stellar after 2 min (status ${st.wallet?.status})`);
    if (st.wallet?.status === "failed") throw new Error("wallet creation failed on Stellar");
    await sleep(500);
    st = await t("onboarding_status");
  }
  const walletMs = Date.now() - t0;
  log(`  ✓ wallet on Stellar      ${(walletMs / 1000).toFixed(1)} s from Yes to tick  ${st.wallet.tx_url}`);

  const fin = must(await t("finish_onboarding"), "finish_onboarding");
  // The app signs in with the one-time token (never emailed).
  const sb = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.verifyOtp({ token_hash: fin.sign_in_token, type: "magiclink" });
  if (error || !data.session) throw new Error(`sign-in after sign-up: ${error?.message}`);
  return {
    userId: st.onboarding_id ? (await call("agent-tools/get_user", {}, data.session.access_token)).user_id : "",
    phone: st.phone,
    wallet: st.wallet.address,
    walletTx: st.wallet.tx_url,
    virtualAccount: st.wallet.virtual_account,
    tier: st.tier,
    accessToken: data.session.access_token,
    steps,
    walletMs,
  };
}

/** Sign in again later with phone + PIN (what the app's "I have an account" does). */
export async function signIn(url: string, anonKey: string, phone: string, pin: string): Promise<string> {
  const r = await plusFetch(url)("agent-tools/sign_in", { market: "ng", phone, pin });
  if (!r.ok) throw new Error(`sign_in: ${r.error}`);
  const sb = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.verifyOtp({ token_hash: r.sign_in_token, type: "magiclink" });
  if (error || !data.session) throw new Error(`sign_in verify: ${error?.message}`);
  return data.session.access_token;
}
