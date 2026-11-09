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
import { callerFromBody } from "../_shared/caller.ts";
import { bearer, json, kickChainWorker, preflight, readJson } from "../_shared/http.ts";
import { formatMoney, getMarket } from "../_shared/markets.ts";
import { hasSessionToken, verifySession } from "../_shared/session.ts";
import { supabaseStore } from "../_shared/store.ts";
import { APP_TOOLS, type Channel, type Store, type ToolResult, type User, VOICE_TOOLS } from "../_shared/tools.ts";

// Provided by the Supabase Edge Runtime.
declare const EdgeRuntime: { waitUntil(p: PromiseLike<unknown>): void };

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const HORIZON_URL = Deno.env.get("HORIZON_URL") ?? "https://horizon-testnet.stellar.org";
const NGNT_ISSUER = Deno.env.get("NGNT_ISSUER") ?? "GDLLQ6TC6GJBOOWCTBTMDMFWRKUHKW7UOWZMIA6WZNCZJHTC3UBS3SVB";
const USDC_ISSUER = Deno.env.get("USDC_ISSUER") ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ?? "Test SDF Network ; September 2015";
const EXPLORER = `https://stellar.expert/explorer/${PASSPHRASE.startsWith("Public") ? "public" : "testnet"}`;
const CONTRACT_ID = Deno.env.get("PLUS_CONTRACT_ID") ?? "";
const USER_COLS = "id, market_id, name, language, kyc_tier, stellar_pub, auto_save_bps, ref_hash, trusted_contact_phone";

// ---------------------------------------------------------------------------
// Nigeria balances come from the user's own Stellar account (Horizon).
// ---------------------------------------------------------------------------

function decimalToMinor(value: string): bigint {
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
}

async function stellarBalance(user: User): Promise<ToolResult> {
  if (!user.stellar_pub) return { text: "There is no wallet set up yet.", has_account: false };
  const res = await fetch(`${HORIZON_URL}/accounts/${user.stellar_pub}`);
  if (res.status === 404) return { text: "The wallet is not active yet.", has_account: false };
  if (!res.ok) throw new Error(`horizon ${res.status}`);
  const acct = await res.json() as { balances: { asset_code?: string; asset_issuer?: string; balance: string }[] };
  const line = (code: string, issuer: string) => acct.balances.find((b) => b.asset_code === code && b.asset_issuer === issuer)?.balance;
  const ngnt = decimalToMinor(line("NGNT", NGNT_ISSUER) ?? "0");
  const usdc = line("USDC", USDC_ISSUER);
  const usd = usdc ? decimalToMinor(usdc) : 0n;
  const usdText = `$${usd / 100n}.${(usd % 100n).toString().padStart(2, "0")}`;
  return {
    text: `She has ${formatMoney(ngnt, user.market_id).replace("₦", "")} naira` + (usd > 0n ? ` and ${usdText} in dollars.` : "."),
    has_account: true,
    currency: getMarket(user.market_id).currency.code,
    balance_minor: String(ngnt),
    balance_text: formatMoney(ngnt, user.market_id),
    usd_text: usd > 0n ? usdText : null,
  };
}

const store: Store = { ...supabaseStore(db), stellarBalance };

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

type Identity = { channel: Channel; user: User | null } | { error: Response };

async function identify(req: Request, args: Record<string, unknown>): Promise<Identity> {
  if (hasValidAgentSecret(req)) {
    if (hasSessionToken(args.plus_session)) {
      const check = await verifySession(args.plus_session, Deno.env.get("VOICE_SESSION_SECRET") ?? "");
      if (!check.ok) return { error: json({ error: `${check.error}_session` }, 401) };
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
      !/pin|secret|otp|password|session|caller|phone/i.test(k)
    ),
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
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
    const who = await identify(req, args);
    if ("error" in who) return who.error;
    channel = who.channel;
    const probe = tool === "_time_record_of" && channel === "voice";
    const handler = (channel === "app" ? APP_TOOLS : VOICE_TOOLS)[tool];
    if (!handler && !probe) return json({ error: "unknown_tool", tool }, 404);

    if (!who.user) {
      result = { text: "I don't recognise this number yet. Offer to set up Plus for them.", known: false };
    } else {
      userId = who.user.id;
      result = probe
        ? await timeRecordOf(who.user)
        : await handler({ user: who.user, channel, store, args, explorer: EXPLORER, contractId: CONTRACT_ID });
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
});
