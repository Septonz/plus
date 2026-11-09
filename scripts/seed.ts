// Plus testnet seed. Run with `pnpm seed`. `pnpm seed --fresh` redeploys the
// contract first (new `plus` alias, bindings, Supabase secret, web env), so totals
// never double.
//
// - TESTNET ONLY. The script refuses any other network.
// - Keys are read through the stellar CLI (`stellar keys secret <name>`) and are
//   never printed or written anywhere.
// - Re-runnable: every transaction is recorded in scripts/.seed-state.json. The
//   hash is saved BEFORE submitting; on a rerun a pending hash is looked up on-chain
//   and only rebuilt once it has provably failed or expired (never resubmitted blindly).
// - Network errors ("fetch failed") are retried 3 times with exponential backoff via
//   supabase/functions/_shared/stellar-retry.ts; submissions with an unknown outcome
//   are looked up by hash before anything is resent.
// - USDC comes from Circle's web faucet. Steps that need USDC are skipped with a
//   warning and picked up on the next run.

import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import type * as PlusClient from "@plus/client";
import {
  OutcomeUnknownError,
  SubmitRejectedError,
  submitTransaction,
  withRetry,
} from "../supabase/functions/_shared/stellar-retry.ts";
import type { RetryOptions } from "../supabase/functions/_shared/stellar-retry.ts";

// Loaded at runtime, after a possible --fresh redeploy has regenerated the bindings.
let lib: typeof PlusClient;

// ---------------------------------------------------------------------------
// Network (testnet only)
// ---------------------------------------------------------------------------

const NETWORK = "testnet";
const PASSPHRASE = "Test SDF Network ; September 2015";
const RPC_URL = "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const EXPERT = "https://stellar.expert/explorer/testnet";

// Circle testnet USDC (developers.stellar.org, "Testnet USDC").
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const NGNT_CODE = "NGNT";

const DECIMALS = 10_000_000n; // i128 with 7 decimals
const DAY = 86_400n;
const units = (n: number | bigint): bigint => BigInt(n) * DECIMALS;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = join(ROOT, "scripts", ".seed-state.json");
const DOCS_FILE = join(ROOT, "docs", "deployments.md");

const server = new rpc.Server(RPC_URL);
const horizon = new Horizon.Server(HORIZON_URL);

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function stellar(args: string[]): string {
  return execFileSync("stellar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const NAMES = ["admin", "partner", "sender_ca", "issuer", "mm", "amaka", "ng_member2", "ng_member3", "agent_ng"] as const;
type Name = (typeof NAMES)[number];

const pub: Record<string, string> = {};
const keypairs: Record<string, Keypair> = {};
function kp(name: Name): Keypair {
  // Secret stays in memory only.
  keypairs[name] ??= Keypair.fromSecret(stellar(["keys", "secret", name]));
  return keypairs[name];
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type StepState = { status: "pending" | "done"; hash: string; xdr?: string; maxTime?: number; value?: unknown };
type State = { network: string; contractId: string; createdAt: string; steps: Record<string, StepState> };

let state: State;
function save() {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

const warnings: string[] = [];
let ran = 0;
let skipped = 0;

// ---------------------------------------------------------------------------
// Transaction pipeline: sign -> save hash -> submit -> poll
// ---------------------------------------------------------------------------

const retry: RetryOptions = {
  attempts: 3,
  baseDelayMs: 1000,
  onRetry: (err, attempt, ms) =>
    console.log(`  retry network error (attempt ${attempt}/3${ms ? `, waiting ${ms} ms` : ""}): ${(err as Error).message}`),
};
const net = <T>(fn: () => Promise<T>) => withRetry(fn, retry);

function valueOf(res: rpc.Api.GetTransactionResponse): unknown {
  return res.status === rpc.Api.GetTransactionStatus.SUCCESS && res.returnValue
    ? scValToNative(res.returnValue)
    : undefined;
}

/** Save hash, submit through the shared safe submitter, record the outcome. */
async function submit(key: string, tx: Transaction): Promise<unknown> {
  const hash = tx.hash().toString("hex");
  state.steps[key] = { status: "pending", hash, xdr: tx.toXDR(), maxTime: Number(tx.timeBounds?.maxTime ?? 0) };
  save(); // hash is on disk before the network sees the transaction

  let res: rpc.Api.GetTransactionResponse;
  try {
    res = await submitTransaction(server, tx, retry);
  } catch (e) {
    if (e instanceof SubmitRejectedError) {
      delete state.steps[key]; // rejected by RPC: nothing was applied
      save();
      const code = (e.result as rpc.Api.SendTransactionResponse).errorResult?.result().switch().name ?? "unknown";
      throw new Error(`${key}: submission rejected (${code})`);
    }
    if (e instanceof OutcomeUnknownError) throw new Error(`${key}: ${hash} not found yet; rerun to look it up again`);
    throw e; // pending hash stays on disk: the next run looks it up
  }
  if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    const value = valueOf(res);
    state.steps[key] = { status: "done", hash, value };
    save();
    return value;
  }
  delete state.steps[key];
  save();
  throw new Error(`${key}: transaction ${hash} failed on-chain`);
}

/** Run one transaction exactly once across reruns. */
async function step(key: string, label: string, build: () => Promise<Transaction>): Promise<unknown> {
  const prev = state.steps[key];
  if (prev?.status === "done") {
    skipped++;
    console.log(`  skip  ${label}`);
    return prev.value;
  }
  if (prev?.status === "pending") {
    const res = await net(() => server.getTransaction(prev.hash));
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      state.steps[key] = { status: "done", hash: prev.hash, value: valueOf(res) };
      save();
      skipped++;
      console.log(`  skip  ${label} (pending tx confirmed)`);
      return state.steps[key].value;
    }
    const expired = prev.maxTime !== undefined && Date.now() / 1000 > prev.maxTime + 10;
    if (res.status === rpc.Api.GetTransactionStatus.NOT_FOUND && !expired && prev.xdr) {
      // Looked up: not seen and not expired. The same signed envelope (same hash) is safe to resend.
      console.log(`  wait  ${label} (re-sending pending ${prev.hash.slice(0, 8)})`);
      const value = await submit(key, TransactionBuilder.fromXDR(prev.xdr, PASSPHRASE) as Transaction);
      ran++;
      return value;
    }
    // FAILED, or NOT_FOUND after expiry: provably not applied, so rebuild.
    delete state.steps[key];
  }
  const tx = await net(build); // simulate + sign only, nothing submitted: safe to retry
  const value = await submit(key, tx);
  ran++;
  console.log(`  done  ${label}  ${tx.hash().toString("hex").slice(0, 12)}`);
  return value;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

let clients: Record<string, PlusClient.Client> = {};
let CONTRACT_ID = "";

function plus(name: Name): PlusClient.Client {
  clients[name] ??= new lib.Client({
    contractId: CONTRACT_ID,
    networkPassphrase: PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: pub[name],
    ...basicNodeSigner(kp(name), PASSPHRASE),
  });
  return clients[name];
}

type Assembled = {
  simulation?: unknown;
  sign: (o?: { force?: boolean }) => Promise<void>;
  signed?: Transaction;
};

/** Simulate + sign a contract call; refuse to submit if simulation failed. */
async function contractTx(at: Assembled): Promise<Transaction> {
  const sim = at.simulation as rpc.Api.SimulateTransactionResponse | undefined;
  if (sim && rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`);
  await at.sign({ force: true });
  if (!at.signed) throw new Error("transaction was not signed");
  return at.signed;
}

async function classicTx(name: Name, ops: ReturnType<typeof Operation.payment>[]): Promise<Transaction> {
  const account = await net(() => horizon.loadAccount(pub[name]));
  const b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE }).setTimeout(60);
  for (const op of ops) b.addOperation(op);
  const tx = b.build();
  tx.sign(kp(name));
  return tx;
}

async function balance(name: Name, asset: Asset): Promise<number> {
  const acct = await net(() => horizon.loadAccount(pub[name]));
  const line = acct.balances.find(
    (b) => "asset_code" in b && b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );
  return line ? Number(line.balance) : -1; // -1 = no trustline
}

const opts = { timeoutInSeconds: 60 };
const acct = (a: string): PlusClient.Party => ({ tag: "Account", values: [a] });
const ref = (b: Buffer): PlusClient.Party => ({ tag: "Ref", values: [b] });

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const fresh = process.argv.includes("--fresh");
  const network = process.env.STELLAR_NETWORK ?? NETWORK;
  if (network !== "testnet") throw new Error(`refusing to seed network "${network}": testnet only`);

  for (const n of NAMES) pub[n] = stellar(["keys", "address", n]);
  CONTRACT_ID = process.env.PLUS_CONTRACT_ID ?? stellar(["contract", "alias", "show", "plus", "--network", NETWORK]);

  state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : undefined;
  lib = await import("@plus/client");
  if (fresh) {
    CONTRACT_ID = await redeploy();
    // Bindings were regenerated; a fresh module URL picks up the new build.
    const dist = pathToFileURL(join(ROOT, "packages", "plus-client", "dist", "index.js")).href;
    lib = await import(`${dist}?v=${Date.now()}`);
  }
  if (!state || state.contractId !== CONTRACT_ID || state.network !== NETWORK) {
    if (state) console.log(`contract changed (${state.contractId} -> ${CONTRACT_ID}): starting new seed state`);
    state = { network: NETWORK, contractId: CONTRACT_ID, createdAt: new Date().toISOString(), steps: {} };
    save();
  }

  const USDC = new Asset("USDC", USDC_ISSUER);
  const NGNT = new Asset(NGNT_CODE, pub.issuer);
  const USDC_SAC = USDC.contractId(PASSPHRASE);
  const NGNT_SAC = NGNT.contractId(PASSPHRASE);

  console.log(`Plus seed on ${NETWORK}`);
  console.log(`  contract ${CONTRACT_ID}`);
  console.log(`  USDC SAC ${USDC_SAC}`);
  console.log(`  NGNT SAC ${NGNT_SAC}\n`);

  const cfg = (await net(() => plus("admin").config())).result;
  if (!cfg.assets.includes(NGNT_SAC)) {
    await step("admin:add_asset:ngnt", "add_asset(NGNT)", async () =>
      contractTx(await plus("admin").add_asset({ asset: NGNT_SAC }, opts)),
    );
  }

  // ----- trustlines ------------------------------------------------------
  console.log("Trustlines");
  const needs: [Name, Asset[]][] = [
    ["sender_ca", [USDC]],
    ["partner", [USDC, NGNT]],
    ["mm", [USDC, NGNT]],
    ["amaka", [NGNT]],
    ["ng_member2", [NGNT]],
    ["ng_member3", [NGNT]],
    ["agent_ng", [NGNT]],
  ];
  for (const [name, assets] of needs) {
    const missing: Asset[] = [];
    for (const a of assets) if ((await balance(name, a)) < 0) missing.push(a);
    const label = `${name} trusts ${assets.map((a) => a.getCode()).join(", ")}`;
    if (missing.length === 0) {
      skipped++;
      console.log(`  skip  ${label}`);
      continue;
    }
    await step(`trust:${name}:${missing.map((a) => a.getCode()).join(",")}`, label, () =>
      classicTx(name, missing.map((asset) => Operation.changeTrust({ asset }))),
    );
  }

  // ----- India -----------------------------------------------------------
  console.log("\nIndia: Selvi's history (partner attests)");
  const neighbours = ["selvi", "lakshmi", "meena", "kavitha", "revathi"] as const;
  const userRef = Object.fromEntries(neighbours.map((n) => [n, sha256(`plus-demo:${n}`)])) as Record<
    (typeof neighbours)[number],
    Buffer
  >;
  const selvi = userRef.selvi;
  const partner = plus("partner");

  const wages = [1500, 1450, 1600, 1500, 1550, 1400, 1500, 1650];
  for (let w = 1; w <= 8; w++) {
    const wage = wages[w - 1];
    await step(`selvi:w${w}:wage`, `week ${w}: Received wage Rs ${wage}`, async () =>
      contractTx(
        await partner.attest(
          { user_ref: selvi, kind: lib.AttestKind.Received, amount: units(wage), payment_ref: sha256(`plus-demo:selvi:wage:w${w}`) },
          opts,
        ),
      ),
    );
    await step(`selvi:w${w}:wage:saved`, `week ${w}: Saved Rs ${wage / 10}`, async () =>
      contractTx(
        await partner.attest(
          { user_ref: selvi, kind: lib.AttestKind.Saved, amount: units(wage) / 10n, payment_ref: sha256(`plus-demo:selvi:save:wage:w${w}`) },
          opts,
        ),
      ),
    );
    if (w === 1 || w === 5) {
      const m = w === 1 ? 1 : 2;
      await step(`selvi:m${m}:transfer`, `month ${m}: Received state transfer Rs 1000`, async () =>
        contractTx(
          await partner.attest(
            { user_ref: selvi, kind: lib.AttestKind.Received, amount: units(1000), payment_ref: sha256(`plus-demo:selvi:dbt:m${m}`) },
            opts,
          ),
        ),
      );
      await step(`selvi:m${m}:transfer:saved`, `month ${m}: Saved Rs 100`, async () =>
        contractTx(
          await partner.attest(
            { user_ref: selvi, kind: lib.AttestKind.Saved, amount: units(100), payment_ref: sha256(`plus-demo:selvi:save:dbt:m${m}`) },
            opts,
          ),
        ),
      );
      await step(`selvi:m${m}:seettu:paid`, `month ${m}: Paid seettu Rs 200`, async () =>
        contractTx(
          await partner.attest(
            { user_ref: selvi, kind: lib.AttestKind.Paid, amount: units(200), payment_ref: sha256(`plus-demo:seettu:selvi:m${m}`) },
            opts,
          ),
        ),
      );
    }
  }

  console.log("\nIndia: seettu (record mode)");
  // Record mode moves no tokens; `asset` is a required field, USDC is a placeholder.
  const seettuId = (await step("seettu:create", "group_create(seettu, 5 Ref members, Rs 200, 30 days)", async () =>
    contractTx(
      await partner.group_create(
        {
          organizer: pub.partner,
          members: neighbours.map((n) => ref(userRef[n])),
          asset: USDC_SAC,
          amount: units(200),
          period_secs: 30n * DAY,
          pooled: false,
        },
        opts,
      ),
    ),
  )) as number;
  for (const m of [1, 2]) {
    for (const n of neighbours) {
      await step(`seettu:record:${n}:m${m}`, `group_record(${n}, month ${m}, Rs 200)`, async () =>
        contractTx(
          await partner.group_record(
            { group_id: seettuId, member_ref: userRef[n], amount: units(200), payment_ref: sha256(`plus-demo:seettu:${n}:m${m}`) },
            opts,
          ),
        ),
      );
    }
  }

  console.log("\nIndia: credit limit");
  await step("selvi:limit", "set_credit_limit(Ref selvi, Rs 5000)", async () =>
    contractTx(await partner.set_credit_limit({ borrower: ref(selvi), limit: units(5000) }, opts)),
  );

  console.log("\nFamily dollar fund (sender_ca)");
  // v1 of the fund (25 USDC per period) was created but never funded: close it once.
  const oldPot = state.steps["pot:create"];
  if (oldPot?.status === "done") {
    await step("pot:cancel:v1", `pot_cancel(pot ${oldPot.value}, unfunded 25 USDC v1)`, async () =>
      contractTx(await plus("sender_ca").pot_cancel({ sender: pub.sender_ca, pot_id: oldPot.value as number }, opts)),
    );
  }
  // 5 USDC per period, funded with 10 USDC; sender_ca's remaining USDC stays free for the SEP-31 spike.
  const potId = (await step("pot:create:v2", "pot_create(sender_ca -> sender_ca, 5 USDC / 30 days)", async () =>
    contractTx(
      await plus("sender_ca").pot_create(
        { sender: pub.sender_ca, payout_to: pub.sender_ca, asset: USDC_SAC, per_period: units(5), period_secs: 30n * DAY },
        opts,
      ),
    ),
  )) as number;
  if (state.steps["pot:fund:v2"]?.status === "done" || (await balance("sender_ca", USDC)) >= 10) {
    await step("pot:fund:v2", "pot_fund(10 USDC)", async () =>
      contractTx(await plus("sender_ca").pot_fund({ sender: pub.sender_ca, pot_id: potId, amount: units(10) }, opts)),
    );
  } else {
    warnings.push(`pot_fund skipped: sender_ca has < 10 USDC (${pub.sender_ca})`);
    console.log("  WARN  pot_fund skipped: sender_ca needs 10 USDC (rerun after the faucet)");
  }

  // ----- Nigeria ---------------------------------------------------------
  console.log("\nNigeria: NGNT distribution");
  const grants: [Name, number][] = [
    ["amaka", 50_000],
    ["ng_member2", 50_000],
    ["ng_member3", 50_000],
    ["partner", 500_000],
    ["mm", 1_000_000],
  ];
  await step("ngnt:issue", `issuer pays NGNT to ${grants.map((g) => g[0]).join(", ")}`, () =>
    classicTx(
      "issuer",
      grants.map(([name, amount]) => Operation.payment({ destination: pub[name], asset: NGNT, amount: String(amount) })),
    ),
  );
  // Cash agent float: agent_ng swaps cash for NGNT (cashIn agent_float), up to helperFloatLimit per day.
  await step("ngnt:float:agent_ng", "issuer pays agent_ng a 200,000 NGNT float", () =>
    classicTx("issuer", [Operation.payment({ destination: pub.agent_ng, asset: NGNT, amount: "200000" })]),
  );

  console.log("\nNigeria: market maker offers (1 USDC = 1,500 NGNT mid)");
  if (state.steps["mm:offers"]?.status === "done" || (await balance("mm", USDC)) >= 10) {
    await step("mm:offers", "mm sells 150,000 NGNT @ 1,490/USDC and 10 USDC @ 1,510 NGNT", () =>
      classicTx("mm", [
        // Sell NGNT for USDC: price = USDC per NGNT.
        Operation.manageSellOffer({ selling: NGNT, buying: USDC, amount: "150000", price: { n: 1, d: 1490 } }),
        // Buy NGNT with USDC: price = NGNT per USDC.
        Operation.manageSellOffer({ selling: USDC, buying: NGNT, amount: "10", price: { n: 1510, d: 1 } }),
      ]),
    );
  } else {
    warnings.push(`mm offers waiting: mm has < 10 USDC (${pub.mm})`);
    console.log("  skip  offers: waiting until mm has 10 USDC (placed on the next run after that)");
  }

  console.log("\nNigeria: pooled ajo");
  const ajoMembers: Name[] = ["amaka", "ng_member2", "ng_member3"];
  const ajoId = (await step("ajo:create", "group_create(ajo, amaka + 2, 5,000 NGNT, 1 day, pooled)", async () =>
    contractTx(
      await plus("amaka").group_create(
        {
          organizer: pub.amaka,
          members: ajoMembers.map((n) => acct(pub[n])),
          asset: NGNT_SAC,
          amount: units(5000),
          period_secs: DAY,
          pooled: true,
        },
        opts,
      ),
    ),
  )) as number;

  console.log("\nNigeria: advance pool");
  await step("pool:ngnt", "fund_pool(NGNT, 200,000)", async () =>
    contractTx(await partner.fund_pool({ asset: NGNT_SAC, amount: units(200_000) }, opts)),
  );
  await step("amaka:limit", "set_credit_limit(Account amaka, 30,000 NGNT)", async () =>
    contractTx(await partner.set_credit_limit({ borrower: acct(pub.amaka), limit: units(30_000) }, opts)),
  );

  // ----- docs ------------------------------------------------------------
  const wasm = await net(() => server.getContractWasmByContractId(CONTRACT_ID));
  const wasmHash = createHash("sha256").update(wasm).digest("hex");
  let commit = "";
  try {
    commit = execFileSync("git", ["log", "-1", "--format=%h", "--", "contracts/plus"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {}
  writeDocs({ USDC_SAC, NGNT_SAC, wasmHash, commit, seettuId, potId, ajoId, userRef });

  console.log(`\n${ran} transaction(s) sent, ${skipped} step(s) already done.`);
  console.log(`Seettu group ${seettuId}, ajo group ${ajoId}, family pot ${potId}`);
  console.log("Wrote docs/deployments.md");
  if (warnings.length) {
    console.log("\nWARNINGS (rerun `pnpm seed` once fixed):");
    for (const w of warnings) console.log(`  - ${w}`);
    console.log(`\nGet test USDC at https://faucet.circle.com (network: Stellar Testnet), ~20 USDC each to:`);
    for (const n of ["sender_ca", "partner", "mm"] as Name[]) console.log(`  ${n.padEnd(10)} ${pub[n]}`);
  }
}

const USDC_SAC_ID = new Asset("USDC", USDC_ISSUER).contractId(PASSPHRASE);
const SUPABASE_REF = "qoqmnjzfjhpemwleipth"; // Plus dev project (testnet values only)
const WEB_ENV = join(ROOT, "apps", "web", ".env.local");

function pnpmRun(args: string[]) {
  // npm_execpath (set by pnpm) is either its JS entry or a native pnpm.exe: no shell needed.
  const p = process.env.npm_execpath;
  if (p && /\.[cm]?js$/.test(p)) execFileSync(process.execPath, [p, ...args], { cwd: ROOT, stdio: "inherit" });
  else if (p && /\.exe$/i.test(p)) execFileSync(p, args, { cwd: ROOT, stdio: "inherit" });
  else execSync(`pnpm ${args.join(" ")}`, { cwd: ROOT, stdio: "inherit" });
}

/**
 * --fresh: refund what the seed put into the old contract's family pot, deploy a new
 * contract under the `plus` alias, regenerate bindings, point Supabase and the web
 * app at it, and start a new seed state.
 */
async function redeploy(): Promise<string> {
  console.log("--fresh: redeploying the contract");
  const old = state;
  const potStep = old?.steps["pot:create:v2"];
  if (old && potStep?.status === "done" && old.steps["pot:fund:v2"]?.status === "done") {
    // Give sender_ca its USDC back before the old contract is abandoned.
    CONTRACT_ID = old.contractId;
    await step("fresh:refund:pot", `pot_cancel(pot ${potStep.value}) on old contract, refund sender_ca`, async () =>
      contractTx(await plus("sender_ca").pot_cancel({ sender: pub.sender_ca, pot_id: potStep.value as number }, opts)),
    );
  }

  execFileSync("stellar", ["contract", "build", "--package", "plus"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  // A deployment is a submission: never retried automatically. If it fails, rerun --fresh.
  const out = stellar([
    "contract", "deploy",
    "--wasm", join(ROOT, "target", "wasm32v1-none", "release", "plus.wasm"),
    "--source-account", "admin",
    "--network", NETWORK,
    "--alias", "plus",
    "--", "--admin", "admin", "--partner", "partner", "--usdc", USDC_SAC_ID, "--advance_fee_bps", "150",
  ]);
  const id = out.split(/\s+/).pop() ?? "";
  if (!/^C[A-Z2-7]{55}$/.test(id)) throw new Error(`unexpected deploy output: ${out}`);
  console.log(`  done  deployed ${id}`);

  rmSync(STATE_FILE, { force: true });
  state = undefined as unknown as State;
  clients = {};

  console.log("  ...   pnpm bindings");
  pnpmRun(["bindings"]);

  // id is validated above (contract strkey only), so it is safe on a command line.
  execSync(`npx -y supabase secrets set --yes --project-ref ${SUPABASE_REF} PLUS_CONTRACT_ID=${id}`, {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
  console.log("  done  Supabase secret PLUS_CONTRACT_ID");

  const line = `VITE_PLUS_CONTRACT_ID=${id}`;
  const env = existsSync(WEB_ENV) ? readFileSync(WEB_ENV, "utf8") : "";
  const next = /^VITE_PLUS_CONTRACT_ID=.*$/m.test(env)
    ? env.replace(/^VITE_PLUS_CONTRACT_ID=.*$/m, line)
    : `${env}${env && !env.endsWith("\n") ? "\n" : ""}${line}\n`;
  writeFileSync(WEB_ENV, next);
  console.log("  done  apps/web/.env.local");
  return id;
}

function writeDocs(d: {
  USDC_SAC: string;
  NGNT_SAC: string;
  wasmHash: string;
  commit: string;
  seettuId: number;
  potId: number;
  ajoId: number;
  userRef: Record<string, Buffer>;
}) {
  const a = (g: string) => `[\`${g}\`](${EXPERT}/account/${g})`;
  const c = (id: string) => `[\`${id}\`](${EXPERT}/contract/${id})`;
  const roles: Record<Name, string> = {
    admin: "Contract admin (OpenZeppelin access control)",
    partner: "Partner: attestations, records, credit limits, advance pool",
    sender_ca: "Diaspora sender (Canada), family dollar fund",
    issuer: "Issuer of the test NGNT asset",
    mm: "Market maker, NGNT/USDC offers",
    amaka: "Nigeria demo user, ajo organizer",
    ng_member2: "Ajo member",
    ng_member3: "Ajo member",
    agent_ng: "Nigeria cash agent (helper), 200,000 NGNT float",
  };
  const date = state.createdAt.slice(0, 10);
  const lines = [
    "# Deployments",
    "",
    "Public addresses and IDs only. Never put secret keys here.",
    "",
    "Generated by `pnpm seed` (scripts/seed.ts). Network: **Stellar Testnet** (`Test SDF Network ; September 2015`), RPC `https://soroban-testnet.stellar.org`.",
    "",
    "## Contracts",
    "",
    "| Network | Contract | Contract ID | WASM hash | Deployed (date) | Commit |",
    "| ------- | -------- | ----------- | --------- | --------------- | ------ |",
    `| testnet | plus | ${c(CONTRACT_ID)} | \`${d.wasmHash}\` | ${date} | ${d.commit} |`,
    "",
    "## Assets (Stellar Asset Contracts)",
    "",
    "| Network | Asset | Issuer | SAC ID |",
    "| ------- | ----- | ------ | ------ |",
    `| testnet | USDC (Circle) | ${a(USDC_ISSUER)} | ${c(d.USDC_SAC)} |`,
    `| testnet | NGNT (test naira) | ${a(pub.issuer)} | ${c(d.NGNT_SAC)} |`,
    "",
    "## Accounts",
    "",
    "| Network | Role | Public address | Notes |",
    "| ------- | ---- | -------------- | ----- |",
    ...NAMES.map((n) => `| testnet | ${n} | ${a(pub[n])} | ${roles[n]} |`),
    "",
    "## Demo objects",
    "",
    "| Object | ID | Details |",
    "| ------ | -- | ------- |",
    `| Seettu (India, record mode) | group ${d.seettuId} | 5 Ref members, Rs 200, 30-day period |`,
    `| Ajo (Nigeria, pooled) | group ${d.ajoId} | amaka, ng_member2, ng_member3; 5,000 NGNT; 1-day period |`,
    `| Family dollar fund | pot ${d.potId} | sender_ca -> sender_ca, 5 USDC every 30 days, funded with 10 USDC |`,
    "",
    "## Demo user refs (India)",
    "",
    "Indian users appear on-chain only as `sha256(\"plus-demo:<name>\")`. Events are searchable on Stellar Expert by contract.",
    "",
    "| Name | user_ref (hex) |",
    "| ---- | -------------- |",
    ...Object.entries(d.userRef).map(([n, b]) => `| ${n} | \`${b.toString("hex")}\` |`),
    "",
  ];
  writeFileSync(DOCS_FILE, lines.join("\n"));
}

main().catch((e) => {
  console.error(`\nseed failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
