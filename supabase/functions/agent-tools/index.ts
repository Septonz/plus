// agent-tools: the one router for Plus tools, used by the voice agent and by the app.
//
//   POST /functions/v1/agent-tools/<tool>
//
// Who is calling (checked before any tool runs):
//   app   - Authorization: Bearer <Supabase access token>. The login is verified and mapped to
//           users.auth_user_id. App-only tools (set_pin, update_settings) and the PIN pad live here.
//   voice - x-plus-secret header (the ElevenLabs workspace secret), then the user from:
//           plus_session (signed 15-minute token minted by voice-session for the app's voice
//           button; invalid or expired -> 401), or, for phone/WhatsApp, caller_id bound to
//           system__caller_id. Never from anything the LLM says.
// Every call is logged to tool_calls with its latency (never PINs, session tokens or phone numbers).
// Tools live in ../_shared/tools.ts so voice and taps share one code path.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { hasValidAgentSecret } from "../_shared/auth.ts";
import { mayRunJob } from "../_shared/cron.ts";
import { callerFromBody } from "../_shared/caller.ts";
import { bearer, json, kickChainWorker, preflight, readJson, health, withCors } from "../_shared/http.ts";
import { demoLoginsEnabled, demoOff, demoRateLimited, MONEY_TOOLS } from "../_shared/demo.ts";
import { hasSessionToken, verifySession } from "../_shared/session.ts";
import { supabaseStore } from "../_shared/store.ts";
import { supabaseNgStore } from "../_shared/store-ng.ts";
import { supabaseAssetStore } from "../_shared/store-assets.ts";
import { APP_TOOLS, type Channel, type Store, type Tool, type ToolResult, type User, VOICE_TOOLS } from "../_shared/tools.ts";
import { NG_APP_TOOLS, NG_VOICE_TOOLS, newShareCode, type NgTool, showShareCode } from "../_shared/tools-ng.ts";
import type { MarketId } from "../_shared/markets.ts";
import { finishCheck, normalizePhone, OB_TOOLS, type ObChannel, type ObSession } from "../_shared/onboarding.ts";
import { signInToken, supabaseOnboardingStore } from "../_shared/store-onboarding.ts";
import { mintSession } from "../_shared/session.ts";
import { verifyPin } from "../_shared/pin.ts";

// Provided by the Supabase Edge Runtime.
declare const EdgeRuntime: { waitUntil(p: PromiseLike<unknown>): void };

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ?? "Test SDF Network ; September 2015";
const EXPLORER = `https://stellar.expert/explorer/${PASSPHRASE.startsWith("Public") ? "public" : "testnet"}`;
const CONTRACT_ID = Deno.env.get("PLUS_CONTRACT_ID") ?? "";
const NGNT_SAC = Deno.env.get("NGNT_SAC_ID") ?? "";
const USER_COLS = "id, market_id, name, language, kyc_tier, stellar_pub, auto_save_bps, ref_hash, trusted_contact_phone, member_since, virtual_account, demo_login";

const store: Store = supabaseStore(db);
// Nigeria: the wallet is the account; money moves through the chain outbox.
const ngStore = supabaseNgStore(db, CONTRACT_ID);
const assetStore = supabaseAssetStore(db);
const obStore = supabaseOnboardingStore(db);
const SESSION_SECRET = Deno.env.get("VOICE_SESSION_SECRET") ?? "";
const PIN_SECRET = Deno.env.get("PIN_PEPPER") ?? "";
const ONBOARDING_TTL_SECS = 2 * 60 * 60;

// ---------------------------------------------------------------------------
// Timing probe (not a voice tool): how long one contract read takes from here.
// ---------------------------------------------------------------------------

async function timeRecordOf(user: User): Promise<ToolResult> {
  const t0 = performance.now();
  const { StellarSdk } = await import("../_shared/stellar.ts");
  const tImport = performance.now();
  if (!user.ref_hash) return { text: "No on-chain ref for this user.", ok: false };
  const { rpc, Contract, TransactionBuilder, Account, Keypair, xdr, scValToNative } = StellarSdk;
  const server = new rpc.Server(Deno.env.get("STELLAR_RPC_URL") ?? "https://soroban-testnet.stellar.org");
  const source = new Account(Keypair.random().publicKey(), "0"); // simulation only: never signed or sent
  const ref = Uint8Array.from(user.ref_hash.match(/../g)!.map((h) => parseInt(h, 16)));
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(CONTRACT_ID).call("record_of", xdr.ScVal.scvBytes(ref as never)))
    .setTimeout(30)
    .build();
  const tSim = performance.now();
  const sim = await server.simulateTransaction(tx);
  const tDone = performance.now();
  if (!rpc.Api.isSimulationSuccess(sim)) return { text: "simulation failed", ok: false, error: sim.error };
  const record = scValToNative(sim.result!.retval);
  return {
    text: `record_of took ${Math.round(tDone - tSim)} ms`,
    ok: true,
    sdk_import_ms: Math.round(tImport - t0),
    simulate_ms: Math.round(tDone - tSim),
    total_ms: Math.round(tDone - t0),
    record: JSON.parse(JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
  };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

type Identity =
  | { channel: Channel; user: User | null }
  | { onboarding: ObSession; obChannel: ObChannel }
  | { error: Response };

/** The agent (helper) behind a bearer token, for agent-assisted sign-up. */
async function agentFromBearer(req: Request): Promise<{ id: string; market_id: MarketId } | null> {
  const token = bearer(req);
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: h } = await db.from("helpers").select("id, market_id, role, active, demo_login").eq("auth_user_id", data.user.id).maybeSingle();
  if (h?.demo_login && !demoLoginsEnabled()) return null;
  return h && h.active && h.role === "agent" ? { id: h.id as string, market_id: h.market_id as MarketId } : null;
}

const EXPIRED = () => json({ error: "invalid_onboarding", text: "This sign-up has expired. Start again." }, 401);

/** A sign-up in progress: the signed onboarding token (sub "ob:<id>"). An agent's sign-up also needs her login. */
async function onboardingFrom(req: Request, token: unknown): Promise<Identity | null> {
  if (!hasSessionToken(token)) return null;
  const check = await verifySession(token, SESSION_SECRET);
  if (!check.ok || !check.userId.startsWith("ob:")) return { error: EXPIRED() };
  const s = await obStore.session(check.userId.slice(3));
  if (!s || s.finished_at || new Date(s.expires_at) < new Date()) return { error: EXPIRED() };
  if (s.helper_id) {
    const agent = await agentFromBearer(req);
    if (!agent || agent.id !== s.helper_id) return { error: json({ error: "unauthorized" }, 401) };
    return { onboarding: s, obChannel: "agent" };
  }
  return { onboarding: s, obChannel: "app" };
}

async function identify(req: Request, args: Record<string, unknown>): Promise<Identity> {
  const ob = await onboardingFrom(req, args.onboarding_token);
  if (ob) return ob;
  if (hasValidAgentSecret(req)) {
    if (hasSessionToken(args.plus_session)) {
      const check = await verifySession(args.plus_session, Deno.env.get("VOICE_SESSION_SECRET") ?? "");
      if (!check.ok) return { error: json({ error: `${check.error}_session` }, 401) };
      // The voice agent guiding a sign-up: the session is bound to the onboarding, not to a user.
      if (check.userId.startsWith("ob:")) {
        const s = await obStore.session(check.userId.slice(3));
        if (!s || s.finished_at) return { error: json({ error: "invalid_session" }, 401) };
        return { onboarding: s, obChannel: "voice" };
      }
      const { data, error } = await db.from("users").select(USER_COLS).eq("id", check.userId).maybeSingle();
      if (error) throw error;
      if (!data) return { error: json({ error: "invalid_session" }, 401) };
      return { channel: "voice", user: data as User };
    }
    const phone = callerFromBody(args);
    if (!phone) return { channel: "voice", user: null };
    const { data, error } = await db.from("users").select(USER_COLS).eq("wa_phone", phone).maybeSingle();
    if (error) throw error;
    return { channel: "voice", user: data as User | null };
  }

  const token = bearer(req);
  if (token) {
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) return { error: json({ error: "unauthorized" }, 401) };
    const { data: user, error: uErr } = await db.from("users").select(USER_COLS).eq("auth_user_id", data.user.id).maybeSingle();
    if (uErr) throw uErr;
    if (!user) return { error: json({ error: "no_plus_account", text: "This login is not linked to a Plus account." }, 403) };
    return { channel: "app", user: user as User };
  }
  return { error: json({ error: "unauthorized" }, 401) };
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([k]) =>
      !/pin|secret|otp|password|session|caller|phone|token|code|nin|id_number|selfie/i.test(k)
    ),
  );
}

// ---------------------------------------------------------------------------
// Sign-up and sign-in (never logged to tool_calls: phone numbers, codes and PINs stay out)
// ---------------------------------------------------------------------------

async function startOnboarding(req: Request, args: Record<string, unknown>): Promise<ToolResult> {
  if (!SESSION_SECRET) return { text: "Sign-up is not set up yet.", ok: false, error: "not_configured" };
  const agent = await agentFromBearer(req);
  const market: MarketId = agent?.market_id ?? (args.market === "in" ? "in" : "ng");
  const s = await obStore.createSession(market, agent?.id ?? null);
  const { token, expiresAt } = await mintSession(`ob:${s.id}`, SESSION_SECRET, { ttlSecs: ONBOARDING_TTL_SECS });
  const status = await OB_TOOLS.onboarding_status({ store: obStore, session: s, channel: agent ? "agent" : "app", args: {}, secret: PIN_SECRET, explorer: EXPLORER });
  return { ...status, onboarding_token: token, expires_at: new Date(expiresAt * 1000).toISOString() };
}

async function runOnboarding(tool: string, s: ObSession, obChannel: ObChannel, args: Record<string, unknown>): Promise<ToolResult> {
  const ctx = { store: obStore, session: s, channel: obChannel, args, secret: PIN_SECRET, explorer: EXPLORER };
  if (tool === "finish_onboarding") {
    if (obChannel === "voice") return { text: "She finishes on her screen.", ok: false, error: "app_only" };
    const notYet = await finishCheck(ctx);
    if (notYet) return notYet;
    await obStore.updateSession(s.id, { finished_at: new Date().toISOString() });
    if (obChannel === "agent") {
      return { text: "Her account is ready. She signs in on her own phone with her number and PIN.", ok: true, finished: true };
    }
    return { text: "Welcome to Plus.", ok: true, finished: true, sign_in_token: await signInToken(db, s.user_id!) };
  }
  const t = OB_TOOLS[tool];
  if (!t) return { text: "Not a sign-up step.", ok: false, error: "unknown_tool" };
  const r = await t(ctx);
  // A wallet was queued: start the worker now so the tick comes in seconds.
  if (tool === "create_wallet" && r.ok !== false) EdgeRuntime.waitUntil(kickChainWorker());
  return r;
}

/** Returning user: phone number + PIN (same PIN lockout as payments) -> a one-time sign-in token. */
async function signIn(args: Record<string, unknown>): Promise<ToolResult> {
  const market: MarketId = args.market === "in" ? "in" : "ng";
  const phone = normalizePhone(market, args.phone);
  const pin = typeof args.pin === "string" ? args.pin : "";
  const wrong = { text: "That number and PIN don't match. Try again.", ok: false, error: "wrong_login" };
  if (!phone || !/^[0-9]{4,6}$/.test(pin)) return wrong;
  const { data: u } = await db.from("users").select("id").eq("wa_phone", phone).is("archived_at", null).maybeSingle();
  if (!u) return wrong;
  const check = await verifyPin(db, u.id as string, pin);
  if (check.outcome === "locked") return { text: "Too many wrong PINs. Try again in 15 minutes.", ok: false, error: "pin_locked" };
  if (!check.ok) return wrong;
  return { text: "Welcome back.", ok: true, sign_in_token: await signInToken(db, u.id as string) };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * GET /warm (pnpm warm, scheduler/warm; cron or agent secret only): /health wakes the isolate, this
 * also opens what a first tap needs: the database, the Stellar SDK (loaded lazily) and the RPC
 * connection, so a warmed first "Simulate transfer received" answers in under a second.
 */
async function deepWarm(req: Request): Promise<Response | null> {
  if (req.method !== "GET" || !new URL(req.url).pathname.endsWith("/warm")) return null;
  if (!(await mayRunJob(req, db))) return json({ error: "unauthorized" }, 401);
  const t0 = performance.now();
  const { data } = await db.from("system_wallets").select("pub").limit(1).maybeSingle();
  const tDb = performance.now();
  const pub = (data as { pub?: string } | null)?.pub;
  if (pub) await ngStore.chain.advanceOf(pub).catch(() => null);
  return json({ ok: true, fn: "agent-tools", db_ms: Math.round(tDb - t0), chain_ms: Math.round(performance.now() - tDb) });
}

Deno.serve(withCors(async (req) => {
  const up = health(req, "agent-tools");
  if (up) return up;
  const warm = await deepWarm(req);
  if (warm) return warm;
  const pre = preflight(req);
  if (pre) return pre;
  const started = performance.now();
  const tool = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();

  const body = await readJson(req);
  if (body instanceof Response) return body;
  const args = body;

  let status = 200;
  let result: ToolResult;
  let userId: string | null = null;
  let channel: Channel | null = null;
  try {
    // No login at all: open a sign-up (an agent's login makes it agent-assisted), or sign in.
    if (tool === "start_onboarding" && !hasSessionToken(args.onboarding_token) && !hasSessionToken(args.plus_session)) {
      return json(await startOnboarding(req, args));
    }
    if (tool === "sign_in") return json(await signIn(args));
    // Public: whether the front door shows the demo people (DEMO_LOGINS_ENABLED).
    if (tool === "demo_logins") return json({ enabled: demoLoginsEnabled() });
    // Public, demo only: /verify's "Try a sample record" (a fresh 24-hour share of Funmi's record).
    if (tool === "sample_record") {
      if (!demoLoginsEnabled()) return json({ ok: false, error: "disabled" }, 404);
      const code = newShareCode();
      const { data, error } = await db.rpc("sample_record_share", { p_code: code });
      if (error) throw new Error(`sample_record_share: ${error.message}`);
      const r = data as { ok: boolean; error?: string; expires_at?: string };
      return json(r.ok ? { ok: true, code: showShareCode(code), expires_at: r.expires_at } : r);
    }

    const who = await identify(req, args);
    if ("error" in who) return who.error;
    if ("onboarding" in who) {
      const r = await runOnboarding(tool, who.onboarding, who.obChannel, args);
      return json({ ...r, latency_ms: Math.round(performance.now() - started) }, r.error === "unknown_tool" ? 404 : 200);
    }
    channel = who.channel;
    // Demo people: refused when the showcase is off, and their money actions are rate-limited.
    const off = demoOff(who.user);
    if (off) return off;
    if (MONEY_TOOLS.has(tool)) {
      const limited = await demoRateLimited(db, who.user, tool);
      if (limited) return limited;
    }
    const probe = tool === "_time_record_of" && channel === "voice";
    const ng = who.user?.market_id === "ng";
    // Nigeria has its own tools; the app's settings tools (PIN, language) are shared.
    const ngHandler: NgTool | undefined = ng ? (channel === "app" ? NG_APP_TOOLS : NG_VOICE_TOOLS)[tool] : undefined;
    const handler: Tool | undefined = ngHandler ? undefined
      : ng && !(tool === "set_pin" || tool === "update_settings") ? undefined
      : (channel === "app" ? APP_TOOLS : VOICE_TOOLS)[tool];
    if (!handler && !ngHandler && !probe && who.user) return json({ error: "unknown_tool", tool }, 404);
    if (!who.user && !(channel === "app" ? APP_TOOLS : VOICE_TOOLS)[tool]) return json({ error: "unknown_tool", tool }, 404);

    if (!who.user) {
      result = { text: "I don't recognise this number yet. Offer to set up Plus for them.", known: false };
    } else {
      userId = who.user.id;
      const base = { user: who.user, channel, args, explorer: EXPLORER, contractId: CONTRACT_ID };
      result = probe
        ? await timeRecordOf(who.user)
        : ngHandler
        ? await ngHandler({ ...base, store: ngStore, assets: assetStore, ngntSac: NGNT_SAC, codeSecret: Deno.env.get("CASHOUT_CODE_SECRET") ?? "" })
        : await handler!({ ...base, store });
      // A confirmed action may have queued on-chain records: start the worker now.
      if (tool === "confirm_action" && result.ok) EdgeRuntime.waitUntil(kickChainWorker());
    }
  } catch (err) {
    status = 500;
    console.error(`agent-tools ${tool} failed`, err instanceof Error ? err.message : err);
    result = { text: "Sorry, I couldn't do that just now. Please try again in a moment.", error: "internal" };
  }

  const latency = Math.round(performance.now() - started);
  // Log after responding. tool_calls never holds a PIN, a session token or the caller's number.
  EdgeRuntime.waitUntil(
    db.from("tool_calls").insert({
      tool,
      user_id: userId,
      args: { ...sanitizeArgs(args), _channel: channel },
      result,
      latency_ms: latency,
      request_id: requestId,
    }).then(({ error }) => {
      if (error) console.error("tool_calls insert failed", error.message);
    }),
  );
  return json({ ...result, latency_ms: latency }, status);
}));
