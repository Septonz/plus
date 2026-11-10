// OnboardingStore backed by Postgres and Supabase Auth (service role). Keys for new wallets are
// generated here and handed straight to ng_create_wallet, which stores them in Vault in the same
// database transaction; they are never logged, returned or kept anywhere else.
import type { SupabaseClient } from "@supabase/supabase-js";
import { isDemoPhone, type MarketId } from "./markets.ts";
import type { ObSession, ObUser, OnboardingStore, WalletProgress } from "./onboarding.ts";
import { setPin } from "./pin.ts";

const SESSION_COLS = "id, market_id, name, language, phone, code_hash, code_expires_at, code_attempts, codes_sent, user_id, helper_id, channel, finished_at, expires_at";
const USER_COLS =
  "id, market_id, name, language, wa_phone, kyc_tier, stellar_pub, ref_hash, selfie_passed, id_last4, trusted_contact_phone, trusted_contact_name, virtual_account, member_since, onboarded_via, archived_at";

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The login behind a Plus account: an internal address nobody receives mail at; sign-in is phone + PIN. */
export const loginEmail = (phone: string) => `p${phone.replace(/\D/g, "")}@users.example.com`;

export function supabaseOnboardingStore(db: SupabaseClient): OnboardingStore {
  return {
    async createSession(market, helperId) {
      return must(
        await db.from("onboarding_sessions").insert({ market_id: market, helper_id: helperId, channel: helperId ? "agent" : "app" }).select(SESSION_COLS).single(),
        "createSession",
      ) as ObSession;
    },
    async session(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      return must(await db.from("onboarding_sessions").select(SESSION_COLS).eq("id", id).maybeSingle(), "session") as ObSession | null;
    },
    async updateSession(id, patch) {
      return must(await db.from("onboarding_sessions").update(patch).eq("id", id).select(SESSION_COLS).single(), "updateSession") as ObSession;
    },
    async user(id) {
      return must(await db.from("users").select(USER_COLS).eq("id", id).maybeSingle(), "user") as ObUser | null;
    },
    async userByPhone(phone) {
      return must(await db.from("users").select(USER_COLS).eq("wa_phone", phone).is("archived_at", null).maybeSingle(), "userByPhone") as ObUser | null;
    },
    async createUser(u) {
      const password = hex(crypto.getRandomValues(new Uint8Array(32))); // never shown or stored; sign-in is phone + PIN
      const { data: auth, error } = await db.auth.admin.createUser({
        email: loginEmail(u.phone),
        password,
        email_confirm: true,
        app_metadata: { plus_role: "user", demo: isDemoPhone(u.market, u.phone) },
      });
      if (error || !auth.user) throw new Error(`createUser auth: ${error?.message ?? "no user"}`);
      const { data, error: insErr } = await db.from("users").insert({
        market_id: u.market,
        wa_phone: u.phone,
        name: u.name,
        language: u.language,
        kyc_tier: 0,
        auth_user_id: auth.user.id,
        onboarded_via: u.via,
        onboarded_by: u.helperId,
        is_demo: isDemoPhone(u.market, u.phone),
        auto_save_bps: 0,
      }).select(USER_COLS).single();
      if (insErr) {
        await db.auth.admin.deleteUser(auth.user.id); // the login was just made and nothing uses it yet
        throw new Error(`createUser: ${insErr.message}`);
      }
      return data as ObUser;
    },
    async updateUser(id, patch) {
      return must(await db.from("users").update(patch).eq("id", id).select(USER_COLS).single(), "updateUser") as ObUser;
    },
    async archiveDemoUser(userId, prefix) {
      const oldAuth = must(await db.rpc("archive_demo_user", { p_user_id: userId, p_prefix: prefix }), "archive_demo_user") as string | null;
      if (oldAuth) {
        // Free the login's address for the new test person and switch the old login off (history stays).
        const { error } = await db.auth.admin.updateUserById(oldAuth, {
          email: `archived-${crypto.randomUUID()}@users.example.com`,
          ban_duration: "876000h",
        });
        if (error) throw new Error(`archive login: ${error.message}`);
      }
    },
    async hasPin(userId) {
      const { count, error } = await db.from("user_credentials").select("user_id", { count: "exact", head: true }).eq("user_id", userId);
      if (error) throw new Error(`hasPin: ${error.message}`);
      return (count ?? 0) > 0;
    },
    setPin: (userId, pin) => setPin(db, userId, pin),
    async createWallet(userId) {
      const { StellarSdk } = await import("./stellar.ts");
      const kp = StellarSdk.Keypair.random();
      const r = must(await db.rpc("ng_create_wallet", { p_user_id: userId, p_pub: kp.publicKey(), p_secret: kp.secret() }), "ng_create_wallet") as {
        created: boolean;
        pub: string;
        virtual_account: string | null;
      };
      return { created: r.created, pub: r.pub, virtual_account: r.virtual_account };
    },
    async walletProgress(userId) {
      const row = must(
        await db.from("chain_outbox").select("status, tx_hash").eq("ref", `create_wallet:${userId}`).maybeSingle(),
        "walletProgress",
      ) as { status: WalletProgress["status"]; tx_hash: string | null } | null;
      return row ?? { status: "none", tx_hash: null };
    },
    async openIndiaAccount(userId) {
      const u = must(await db.from("users").select("ref_hash, market_id").eq("id", userId).single(), "india user") as { ref_hash: string | null; market_id: MarketId };
      if (u.market_id !== "in") throw new Error("not an India user");
      if (!u.ref_hash) {
        // Her on-chain record is keyed by a random 32-byte reference: nothing personal goes on-chain.
        must(await db.from("users").update({ ref_hash: hex(crypto.getRandomValues(new Uint8Array(32))) }).eq("id", userId).is("ref_hash", null).select("id"), "ref_hash");
      }
      const { count } = await db.from("sim_bank_accounts").select("id", { count: "exact", head: true }).eq("user_id", userId);
      if (!count) {
        must(await db.from("sim_bank_accounts").insert({ user_id: userId, balance_paise: 0, savings_paise: 0, bank_name: "Partner bank (simulated)" }).select("id"), "sim bank");
      }
    },
  };
}

/** A one-time sign-in token for the app (Supabase magic-link token, never emailed). */
export async function signInToken(db: SupabaseClient, userId: string): Promise<string> {
  const u = must(await db.from("users").select("auth_user_id").eq("id", userId).single(), "signIn user") as { auth_user_id: string | null };
  if (!u.auth_user_id) throw new Error("no login");
  const { data: au, error } = await db.auth.admin.getUserById(u.auth_user_id);
  if (error || !au.user?.email) throw new Error(`signIn login: ${error?.message ?? "no email"}`);
  const { data, error: linkErr } = await db.auth.admin.generateLink({ type: "magiclink", email: au.user.email });
  if (linkErr || !data.properties?.hashed_token) throw new Error(`signIn link: ${linkErr?.message ?? "no token"}`);
  return data.properties.hashed_token;
}
