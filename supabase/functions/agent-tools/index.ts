// agent-tools: one router for the Plus voice agent's webhook tools (ElevenLabs).
//
//   POST /functions/v1/agent-tools/<tool>     body: { caller_id: "{{system__caller_id}}", ...args }
//
// 1. The x-plus-secret header is checked before anything else.
// 2. The user is identified only by the caller's phone number (system__caller_id), never by
//    anything the LLM says.
// 3. Every call is logged to tool_calls with its latency (never PINs).
// Each tool returns { text, ...fields }: short plain text the agent can read aloud (in English;
// the agent says it in the user's language) plus structured fields.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { hasValidAgentSecret, unauthorized } from "../_shared/auth.ts";
import { callerFromBody } from "../_shared/caller.ts";
import { formatMoney, getMarket, type MarketId } from "../_shared/markets.ts";

// Provided by the Supabase Edge Runtime.
declare const EdgeRuntime: { waitUntil(p: PromiseLike<unknown>): void };

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const HORIZON_URL = Deno.env.get("HORIZON_URL") ?? "https://horizon-testnet.stellar.org";
const NGNT_ISSUER = Deno.env.get("NGNT_ISSUER") ?? "GDLLQ6TC6GJBOOWCTBTMDMFWRKUHKW7UOWZMIA6WZNCZJHTC3UBS3SVB";
const USDC_ISSUER = Deno.env.get("USDC_ISSUER") ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

type User = {
  id: string;
  market_id: MarketId;
  name: string | null;
  language: string;
  kyc_tier: number;
  stellar_pub: string | null;
  auto_save_bps: number;
};
type ToolResult = { text: string; [k: string]: unknown };
type Tool = (user: User, args: Record<string, unknown>) => Promise<ToolResult>;

const LANGUAGE_NAMES: Record<string, string> = { ta: "Tamil", en: "English", yo: "Yoruba", ha: "Hausa", ig: "Igbo" };
const SOURCE_NAMES: Record<string, string> = {
  state_transfer: "the state transfer",
  wages: "wages",
  family_abroad: "family abroad",
  cash: "cash",
  deposit: "a deposit",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const money = (minor: bigint | number | string, market: MarketId) => formatMoney(BigInt(minor), market);

/** "50000.1234567" (7 on-chain decimals) -> minor units (2 decimals), truncating. */
function decimalToMinor(value: string): bigint {
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
}

function usd(value: string): string {
  const cents = decimalToMinor(value);
  return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function whenSpoken(iso: string, now = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([k]) => !/pin|secret|otp|password/i.test(k)));
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const getUser: Tool = async (user) => {
  const market = getMarket(user.market_id);
  const { count } = await db.from("user_credentials").select("user_id", { count: "exact", head: true }).eq(
    "user_id",
    user.id,
  );
  const hasPin = (count ?? 0) > 0;
  const name = user.name ?? "this caller";
  return {
    text: `This is ${name}. Language: ${LANGUAGE_NAMES[user.language] ?? user.language}. ${market.country}. ` +
      `Auto-save is ${user.auto_save_bps / 100}% of money that arrives. PIN ${hasPin ? "is set" : "is not set yet"}.`,
    known: true,
    user_id: user.id,
    name: user.name,
    language: user.language,
    market: user.market_id,
    currency: market.currency.code,
    kyc_tier: user.kyc_tier,
    auto_save_bps: user.auto_save_bps,
    has_pin: hasPin,
    group_savings_name: market.groupSavings.localName,
  };
};

const getBalance: Tool = async (user) => {
  const market = getMarket(user.market_id);
  if (market.custody === "partner_bank") {
    const { data: acct, error } = await db
      .from("sim_bank_accounts")
      .select("balance_paise, savings_paise, bank_name")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw error;
    if (!acct) return { text: "There is no bank account linked yet.", has_account: false };
    const bal = money(acct.balance_paise, user.market_id);
    const sav = money(acct.savings_paise, user.market_id);
    return {
      text: `You have ${bal} to spend and ${sav} saved, in your ${acct.bank_name} account.`,
      has_account: true,
      currency: market.currency.code,
      balance_minor: String(acct.balance_paise),
      savings_minor: String(acct.savings_paise),
      balance_text: bal,
      savings_text: sav,
    };
  }

  // Nigeria: the user's own Stellar account.
  if (!user.stellar_pub) return { text: "There is no wallet set up yet.", has_account: false };
  const res = await fetch(`${HORIZON_URL}/accounts/${user.stellar_pub}`);
  if (res.status === 404) return { text: "Your wallet is not active yet.", has_account: false };
  if (!res.ok) throw new Error(`horizon ${res.status}`);
  const acct = await res.json() as { balances: { asset_code?: string; asset_issuer?: string; balance: string }[] };
  const line = (code: string, issuer: string) =>
    acct.balances.find((b) => b.asset_code === code && b.asset_issuer === issuer)?.balance;
  const ngnt = line("NGNT", NGNT_ISSUER) ?? "0";
  const usdc = line("USDC", USDC_ISSUER);
  const bal = money(decimalToMinor(ngnt), user.market_id);
  return {
    text: `You have ${bal}` + (usdc && usdc !== "0.0000000" ? ` and ${usd(usdc)} in dollars.` : "."),
    has_account: true,
    currency: market.currency.code,
    balance_minor: String(decimalToMinor(ngnt)),
    balance_text: bal,
    usd_text: usdc ? usd(usdc) : null,
  };
};

const whatArrived: Tool = async (user) => {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const [incoming, cash] = await Promise.all([
    db.from("transactions")
      .select("amount, source, created_at")
      .eq("user_id", user.id)
      .eq("kind", "incoming")
      .eq("status", "completed")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5),
    db.from("cash_events")
      .select("id, amount, created_at, helpers(name)")
      .eq("user_id", user.id)
      .eq("direction", "in")
      .eq("status", "awaiting_user")
      .order("created_at", { ascending: false })
      .limit(3),
  ]);
  if (incoming.error) throw incoming.error;
  if (cash.error) throw cash.error;

  const arrived = incoming.data.map((t) => ({
    amount_minor: String(t.amount),
    amount_text: money(t.amount, user.market_id),
    source: t.source,
    when: whenSpoken(t.created_at),
    at: t.created_at,
  }));
  const awaiting = cash.data.map((c) => {
    const helper = (c.helpers as unknown as { name: string } | null)?.name ?? "A helper";
    return {
      cash_event_id: c.id,
      helper,
      amount_minor: String(c.amount),
      amount_text: money(c.amount, user.market_id),
      when: whenSpoken(c.created_at),
    };
  });

  const parts: string[] = [];
  if (arrived.length === 0) parts.push("Nothing new has arrived in the last two weeks.");
  else {
    parts.push(
      "Arrived: " +
        arrived.map((a) => `${a.amount_text} from ${SOURCE_NAMES[a.source ?? ""] ?? a.source ?? "a payment"}, ${a.when}`)
          .join("; ") + ".",
    );
  }
  for (const a of awaiting) {
    parts.push(`${a.helper} recorded ${a.amount_text} cash for you ${a.when}. It counts once you confirm it.`);
  }
  return { text: parts.join(" "), arrived, awaiting_confirmation: awaiting };
};

const TOOLS: Record<string, Tool> = {
  get_user: getUser,
  get_balance: getBalance,
  what_arrived: whatArrived,
};

// ---------------------------------------------------------------------------
// Timing probe (not a voice tool): how long one contract read takes from here.
// Lazy import so the Stellar SDK never slows down the voice tools' cold start.
// ---------------------------------------------------------------------------

async function timeRecordOf(user: User): Promise<ToolResult> {
  const t0 = performance.now();
  const { StellarSdk } = await import("../_shared/stellar.ts");
  const tImport = performance.now();
  const { data } = await db.from("users").select("ref_hash").eq("id", user.id).single();
  if (!data?.ref_hash) return { text: "No on-chain ref for this user.", ok: false };
  const { rpc, Contract, TransactionBuilder, Account, Keypair, Networks, xdr, scValToNative } = StellarSdk;
  const server = new rpc.Server(Deno.env.get("STELLAR_RPC_URL") ?? "https://soroban-testnet.stellar.org");
  const source = new Account(Keypair.random().publicKey(), "0"); // simulation only: never signed or sent
  const ref = Uint8Array.from(data.ref_hash.match(/../g)!.map((h: string) => parseInt(h, 16)));
  const tx = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: Deno.env.get("STELLAR_NETWORK_PASSPHRASE") || Networks.TESTNET,
  })
    .addOperation(new Contract(Deno.env.get("PLUS_CONTRACT_ID")!).call("record_of", xdr.ScVal.scvBytes(ref)))
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
// Router
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (!hasValidAgentSecret(req)) return unauthorized();
  const started = performance.now();
  const tool = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();

  let args: Record<string, unknown> = {};
  if (req.method === "POST") {
    try {
      args = (await req.json()) ?? {};
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
  }

  const handler = tool === "_time_record_of" ? timeRecordOf : TOOLS[tool];
  if (!handler) return Response.json({ error: "unknown_tool", tool }, { status: 404 });

  let status = 200;
  let result: ToolResult;
  let userId: string | null = null;
  try {
    const phone = callerFromBody(args);
    const { data: user, error } = phone
      ? await db.from("users")
        .select("id, market_id, name, language, kyc_tier, stellar_pub, auto_save_bps")
        .eq("wa_phone", phone)
        .maybeSingle()
      : { data: null, error: null };
    if (error) throw error;
    if (!user) {
      result = {
        text: "I don't recognise this number yet. Offer to set up Plus for them.",
        known: false,
      };
    } else {
      userId = user.id;
      result = await handler(user as User, args);
    }
  } catch (err) {
    status = 500;
    console.error(`agent-tools ${tool} failed`, err instanceof Error ? err.message : err);
    result = { text: "Sorry, I couldn't check that just now. Please try again in a moment.", error: "internal" };
  }

  const latency = Math.round(performance.now() - started);
  // Log after responding; tool_calls never holds the caller's number or any PIN.
  const { caller_id: _c, system__caller_id: _s, caller_phone: _p, ...rest } = args;
  EdgeRuntime.waitUntil(
    db.from("tool_calls").insert({
      tool,
      user_id: userId,
      args: sanitizeArgs(rest),
      result,
      latency_ms: latency,
      request_id: requestId,
    }).then(({ error }) => {
      if (error) console.error("tool_calls insert failed", error.message);
    }),
  );
  return Response.json({ ...result, latency_ms: latency }, { status });
});
