// SPIKE (throwaway) fallback: testanchor's SEP-31 has no receive config, so measure the
// closest real flow with Circle testnet USDC: a programmatic SEP-6 withdraw to a fake bank.
// Same mechanics as a SEP-31 send (pay anchor account + memo, poll status).
// Run: node scripts/spikes/sep6-withdraw.ts   (testnet only; keys via stellar CLI, never printed)
import { execFileSync } from "node:child_process";
import { Asset, BASE_FEE, Horizon, Keypair, Memo, Operation, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";

const PASSPHRASE = "Test SDF Network ; September 2015";
const A = "https://testanchor.stellar.org";
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
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
async function http(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(`${A}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text) };
  } catch {
    return { status: r.status, json: { raw: text.slice(0, 120) } };
  }
}

const token = await timed("sep10", async () => {
  const ch = (await http("GET", `/auth?account=${ME}&home_domain=testanchor.stellar.org`)).json;
  WebAuth.readChallengeTx(ch.transaction, "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR", PASSPHRASE, "testanchor.stellar.org", "testanchor.stellar.org");
  const tx = TransactionBuilder.fromXDR(ch.transaction, PASSPHRASE);
  tx.sign(kp);
  return (await http("POST", "/auth", { transaction: tx.toXDR() })).json.token as string;
});

// KYC for the withdrawing customer (fake data).
await timed("sep12", async () => {
  const r = await http("PUT", "/sep12/customer", {
    account: ME,
    first_name: "Test",
    last_name: "Sender",
    email_address: "test.sender@example.com",
    bank_account_number: "000123456789",
    bank_number: "FAKE0000001",
    bank_account_type: "checking",
  }, token);
  console.log(`  PUT customer -> ${r.status} ${JSON.stringify(r.json)}`);
});

const q = new URLSearchParams({ asset_code: "USDC", account: ME, type: "bank_account", funding_method: "bank_account", amount: AMOUNT });
let w = await timed("sep6_withdraw", () => http("GET", `/sep6/withdraw?${q}`, undefined, token));
console.log(`  withdraw -> ${w.status} ${JSON.stringify(w.json)}`);
const id: string | undefined = w.json.id;
if (!id) process.exit(1);

// Payment instructions (account + memo) may arrive later via GET /transaction.
let t: any = w.json;
for (let i = 0; i < 30 && !(t.account_id || t.withdraw_anchor_account); i++) {
  await new Promise((r) => setTimeout(r, 2000));
  t = (await http("GET", `/sep6/transaction?id=${id}`, undefined, token)).json.transaction ?? t;
  if (i === 0 || t.status) console.log(`  status=${t.status}`);
}
const dest = t.account_id ?? t.withdraw_anchor_account;
const memo = t.memo ?? t.withdraw_memo;
const memoType = t.memo_type ?? t.withdraw_memo_type;
console.log(`  pay ${AMOUNT} USDC to ${dest} memo(${memoType}) ${memo}`);
if (!dest) process.exit(1);

const memoObj = memoType === "hash" ? Memo.hash(Buffer.from(memo, "base64").toString("hex")) : memoType === "id" ? Memo.id(String(memo)) : Memo.text(String(memo));
const hash = await timed("payment_submit", async () => {
  const acct = await horizon.loadAccount(ME);
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.payment({ destination: dest, asset: USDC, amount: AMOUNT }))
    .addMemo(memoObj)
    .setTimeout(60)
    .build();
  tx.sign(kp);
  return (await horizon.submitTransaction(tx)).hash;
});
console.log(`  payment https://stellar.expert/explorer/testnet/tx/${hash}`);

const t0 = performance.now();
let status = "";
await timed("payment_to_final", async () => {
  for (let i = 0; i < 200; i++) {
    const s = (await http("GET", `/sep6/transaction?id=${id}`, undefined, token)).json.transaction;
    if (s?.status !== status) {
      status = s?.status;
      console.log(`  +${Math.round((performance.now() - t0) / 1000)}s status=${status}${s?.message ? ` (${s.message})` : ""}`);
    }
    if (["completed", "error", "refunded", "expired", "no_market"].includes(status)) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
});
console.log(`\npayment -> ${status} in ${Math.round((performance.now() - t0) / 1000)} s`);
for (const [k, ms] of times) console.log(`  ${k.padEnd(18)} ${ms} ms`);
