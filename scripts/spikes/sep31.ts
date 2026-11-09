// SPIKE (throwaway): can sender_ca send USDC to India over SEP-31 with the SDF test anchor?
// Run: node scripts/spikes/sep31.ts   (testnet only; keys via the stellar CLI, never printed)
import { execFileSync } from "node:child_process";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
  WebAuth,
} from "@stellar/stellar-sdk";

const PASSPHRASE = "Test SDF Network ; September 2015";
const HOME = "testanchor.stellar.org";
const AMOUNT = process.env.AMOUNT ?? "5";
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");

const kp = Keypair.fromSecret(execFileSync("stellar", ["keys", "secret", "sender_ca"], { encoding: "utf8" }).trim());
const ME = kp.publicKey();

const times: [string, number][] = [];
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  try {
    return await fn();
  } finally {
    const ms = Math.round(performance.now() - t);
    times.push([label, ms]);
    console.log(`  [${label}] ${ms} ms`);
  }
}

async function http(method: string, url: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
const show = (x: unknown) => console.log(JSON.stringify(x, null, 2));

async function main() {
  console.log(`SEP-31 spike: sender_ca ${ME} -> ${HOME}, ${AMOUNT} units\n`);

  // 1. SEP-1
  console.log("1. SEP-1 stellar.toml");
  const toml = await timed("sep1", async () => (await fetch(`https://${HOME}/.well-known/stellar.toml`)).text());
  const get = (k: string) => toml.match(new RegExp(`^${k}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
  const ep = {
    SEP10: get("WEB_AUTH_ENDPOINT"),
    SEP12: get("KYC_SERVER"),
    SEP31: get("DIRECT_PAYMENT_SERVER"),
    SEP38: get("ANCHOR_QUOTE_SERVER"),
    SIGNING_KEY: get("SIGNING_KEY"),
  };
  show(ep);
  if (!ep.SEP10 || !ep.SEP31 || !ep.SIGNING_KEY) throw new Error("anchor is missing SEP-10 or SEP-31");

  // 2. SEP-10
  console.log("\n2. SEP-10 auth");
  const token = await timed("sep10", async () => {
    const ch = await http("GET", `${ep.SEP10}?account=${ME}&home_domain=${HOME}`);
    if (ch.status !== 200) throw new Error(`challenge ${ch.status}: ${JSON.stringify(ch.json)}`);
    const authDomain = new URL(ep.SEP10!).host;
    // Verifies server signature, sequence 0, time bounds, home/web-auth domain.
    WebAuth.readChallengeTx(ch.json.transaction, ep.SIGNING_KEY!, ch.json.network_passphrase ?? PASSPHRASE, HOME, authDomain);
    const tx = TransactionBuilder.fromXDR(ch.json.transaction, PASSPHRASE);
    tx.sign(kp);
    const r = await http("POST", ep.SEP10!, { transaction: tx.toXDR() });
    if (r.status !== 200 || !r.json.token) throw new Error(`token ${r.status}: ${JSON.stringify(r.json)}`);
    return r.json.token as string;
  });
  console.log(`  JWT received (${token.length} chars)`);

  // 3. SEP-31 /info
  console.log("\n3. SEP-31 GET /info (authenticated)");
  const info = await timed("sep31_info", () => http("GET", `${ep.SEP31}/info`, undefined, token));
  show(info.json);
  const receive: Record<string, any> = info.json?.receive ?? {};
  const codes = Object.keys(receive);
  if (codes.length === 0) {
    console.log("  WARNING: /info lists no receive assets. Trying Circle USDC anyway (POST /transactions still validates).");
  }
  const code = process.env.ASSET_CODE ?? (codes.length === 0 || codes.includes("USDC") ? "USDC" : codes[0]);
  const ISSUERS: Record<string, string | undefined> = { USDC: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", SRT: "GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B", native: undefined };
  const a = receive[code] ?? { asset_issuer: ISSUERS[code] };
  console.log(`  using asset ${code}; fee_fixed=${a.fee_fixed} fee_percent=${a.fee_percent} min=${a.min_amount} max=${a.max_amount}`);
  console.log(`  sender types: ${JSON.stringify(a.sep12?.sender?.types ?? {})}`);
  console.log(`  receiver types: ${JSON.stringify(a.sep12?.receiver?.types ?? {})}`);
  console.log(`  transaction fields: ${JSON.stringify(a.fields?.transaction ?? {})}`);

  // 4. SEP-12
  console.log("\n4. SEP-12 PUT customers (fake data)");
  const senderType = Object.keys(a.sep12?.sender?.types ?? { "sep31-sender": {} })[0];
  const receiverType = Object.keys(a.sep12?.receiver?.types ?? { "sep31-receiver": {} })[0];
  const fieldsFor = async (type: string) => {
    const r = await http("GET", `${ep.SEP12}/customer?type=${type}&account=${ME}`, undefined, token);
    return r.json?.fields ?? {};
  };
  const fake: Record<string, string> = {
    first_name: "Test",
    last_name: "Sender",
    email_address: "test.sender@example.com",
    mobile_number: "+15555550100",
    address: "1 Fake St, Toronto",
    address_country_code: "CAN",
    bank_account_number: "000123456789",
    bank_number: "FAKE0000001",
    bank_branch_number: "001",
    clabe_number: "000000000000000000",
    birth_date: "1990-01-01",
    id_type: "passport",
    id_number: "X0000000",
  };
  const putCustomer = async (type: string, overrides: Record<string, string>) => {
    const required = await fieldsFor(type);
    const body: Record<string, string> = { account: ME, type };
    for (const f of Object.keys(required)) if (fake[f]) body[f] = overrides[f] ?? fake[f];
    Object.assign(body, overrides);
    const req = Object.entries(required).filter(([, v]: [string, any]) => !v.optional).map(([k]) => k);
    const opt = Object.entries(required).filter(([, v]: [string, any]) => v.optional).map(([k]) => k);
    console.log(`  ${type} required: ${req.join(", ") || "(none)"}; optional: ${opt.join(", ") || "(none)"}`);
    const r = await http("PUT", `${ep.SEP12}/customer`, body, token);
    console.log(`  PUT ${type} -> ${r.status} ${JSON.stringify(r.json)}`);
    if (!r.json?.id) throw new Error(`SEP-12 ${type} failed`);
    return r.json.id as string;
  };
  const senderId = await timed("sep12_sender", () => putCustomer(senderType, { first_name: "Test", last_name: "Sender" }));
  const receiverId = await timed("sep12_receiver", () =>
    putCustomer(receiverType, { first_name: "Test", last_name: "Receiver", address_country_code: "IND", mobile_number: "+919999900000" }),
  );

  // 5. SEP-38
  let quoteId: string | undefined;
  if (ep.SEP38) {
    console.log("\n5. SEP-38 prices + quote");
    const sell = `stellar:${code}:${a.asset_issuer ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"}`;
    const prices = await timed("sep38_prices", () =>
      http("GET", `${ep.SEP38}/prices?sell_asset=${encodeURIComponent(sell)}&sell_amount=${AMOUNT}&context=sep31`, undefined, token),
    );
    show(typeof prices.json === "string" ? `HTTP ${prices.status} (non-JSON body, ${prices.json.length} bytes)` : prices.json);
    const buy = prices.json?.buy_assets?.[0]?.asset;
    if (buy) {
      const q = await timed("sep38_quote", () =>
        http("POST", `${ep.SEP38}/quote`, { sell_asset: sell, buy_asset: buy, sell_amount: AMOUNT, context: "sep31" }, token),
      );
      show(q.json);
      quoteId = q.json?.id;
    } else {
      console.log("  no buy asset offered for this sell asset; continuing without a quote");
    }
  }

  // 6. SEP-31 POST /transactions
  console.log("\n6. SEP-31 POST /transactions");
  const created = await timed("sep31_create", () =>
    http(
      "POST",
      `${ep.SEP31}/transactions`,
      {
        amount: AMOUNT,
        asset_code: code,
        asset_issuer: a.asset_issuer,
        sender_id: senderId,
        receiver_id: receiverId,
        funding_method: process.env.FUNDING_METHOD ?? "SWIFT",
        ...(quoteId ? { quote_id: quoteId } : {}),
        fields: { transaction: { receiver_routing_number: "FAKE0000001", receiver_account_number: "000123456789", type: "SWIFT" } },
      },
      token,
    ),
  );
  show(created.json);
  const txId: string | undefined = created.json?.id;
  if (!txId) return summary();

  // Payment details may come back on create (older) or only on GET /transactions/:id (newer).
  let t = created.json;
  if (!t.stellar_account_id) {
    for (let i = 0; i < 20 && !(t.stellar_account_id || t.status === "error"); i++) {
      await new Promise((r) => setTimeout(r, 1500));
      t = (await http("GET", `${ep.SEP31}/transactions/${txId}`, undefined, token)).json?.transaction ?? t;
    }
  }
  const dest = t.stellar_account_id;
  const memo = t.stellar_memo;
  const memoType = t.stellar_memo_type;
  console.log(`  pay to ${dest} memo(${memoType}) ${memo} amount_in ${t.amount_in ?? AMOUNT}`);
  if (!dest) return summary();
  if (process.env.SKIP_PAY) {
    console.log("  SKIP_PAY set: not paying");
    return summary();
  }

  const asset = new Asset(code, a.asset_issuer ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
  const memoObj = memoType === "hash" ? Memo.hash(Buffer.from(memo, "base64").toString("hex")) : memoType === "id" ? Memo.id(memo) : Memo.text(memo);
  const payHash = await timed("payment", async () => {
    const acct = await horizon.loadAccount(ME);
    const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(Operation.payment({ destination: dest, asset, amount: String(t.amount_in ?? AMOUNT) }))
      .addMemo(memoObj)
      .setTimeout(60)
      .build();
    tx.sign(kp);
    const r = await horizon.submitTransaction(tx);
    return r.hash;
  });
  console.log(`  payment https://stellar.expert/explorer/testnet/tx/${payHash}`);

  const t0 = performance.now();
  let status = "";
  await timed("until_final", async () => {
    for (let i = 0; i < 120; i++) {
      const r = await http("GET", `${ep.SEP31}/transactions/${txId}`, undefined, token);
      const s = r.json?.transaction?.status;
      if (s !== status) {
        status = s;
        console.log(`  +${Math.round((performance.now() - t0) / 1000)}s status=${s}${r.json?.transaction?.status_message ? ` (${r.json.transaction.status_message})` : ""}`);
      }
      if (["completed", "error", "refunded", "expired"].includes(s)) return;
      await new Promise((res) => setTimeout(res, 3000));
    }
  });
  console.log(`  payment -> ${status}: ${Math.round((performance.now() - t0) / 1000)}s`);
  summary();
}

function summary() {
  console.log("\nTimings");
  for (const [k, ms] of times) console.log(`  ${k.padEnd(16)} ${ms} ms`);
}

main().catch((e) => {
  console.error(`spike failed: ${e instanceof Error ? e.message : String(e)}`);
  summary();
  process.exit(1);
});
