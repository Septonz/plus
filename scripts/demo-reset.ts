// pnpm demo:reset ng | in: put the demo user back to a fixed starting state before a rehearsal.
// TESTNET and the dev project only. Never deletes anything: it only adds transactions (on Stellar
// and in Postgres) and moves statuses forward (pending -> expired, issued -> returned).
//
//   ng (Funmi)  1. Pending actions and agent cash-ins waiting for her Yes -> expired.
//               2. Unused cash-out codes: Mama Bisi claims the claimable balance; the code -> returned.
//               3. Open advance: the partner sends her what she owes, she repays it (fee-bumped).
//               4. Wallet: exactly ₦26,400 NGNT (issuer tops up, or she sends the extra back to the issuer).
//               5. Mama Bisi's float: exactly ₦200,000 NGNT.
//               6. Ajo: if she already paid this round, a new Bodija Market Ajo round starts as a new
//                  on-chain group with the same members; everyone except Funmi pays in (4 of 5 paid).
//   in (Selvi)  1. Pending actions and helper cash-ins waiting for her Yes -> expired.
//               2. Open advance: the partner records a settlement on Stellar.
//               3. Simulated bank: ₹2,350 to spend, ₹1,415 saved (one adjustment row per change).
//               4. Seettu: if she already paid this round, a new round starts (groups.round_started_at).
// Then it prints the state the app shows, read through the same tools the app calls.
//
// Transactions: the hash is written to scripts/.demo-reset-state.json before submitting; an
// unfinished hash from an earlier run is looked up first and only dropped once it provably failed or
// expired (never resubmitted blindly). Keys are read through the stellar CLI and never printed.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Asset, BASE_FEE, Horizon, Keypair, Operation, rpc, scValToNative, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { createClient } from "@supabase/supabase-js";
import type * as PlusClient from "@plus/client";
import { OutcomeUnknownError, submitTransaction } from "../supabase/functions/_shared/stellar-retry.ts";
import { adminClient, loadLocalEnv, ROOT } from "./lib/supabase-admin.ts";

loadLocalEnv();
const market = process.argv[2];
if (market !== "ng" && market !== "in") {
  console.error("usage: pnpm demo:reset ng | in");
  process.exit(2);
}

const PASSPHRASE = "Test SDF Network ; September 2015";
const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-rpc.testnet.stellar.gateway.fm";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const EXPERT = "https://stellar.expert/explorer/testnet";
const STATE_FILE = join(ROOT, "scripts", ".demo-reset-state.json");
const UNIT = 10_000_000n; // 7 decimals on Stellar
const KOBO_PER_UNIT = 100_000n; // 1 NGNT unit (1e-7) -> kobo: units / 1e5

const FUNMI_START = 26_400n; // naira
const FLOAT_START = 200_000n; // naira
const ANCHOR_MIN = 2_000_000n; // naira: the partner bank's anchor pays bank transfers in from this
const SELVI_SPEND = 235_000n; // paise
const SELVI_SAVED = 141_500n; // paise

const server = new rpc.Server(RPC_URL);
const horizon = new Horizon.Server(HORIZON_URL);
const { db, url } = adminClient();
const runRef = `demo_reset:${new Date().toISOString()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The stellar CLI reads STELLAR_* from the environment; .env.local may hold empty ones, so the CLI
// gets the environment without them.
const cliEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("STELLAR_")));
function stellar(args: string[]): string {
  return execFileSync("stellar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: cliEnv }).trim();
}
const pubs: Record<string, string> = {};
const keys: Record<string, Keypair> = {};
const pub = (n: string) => (pubs[n] ??= stellar(["keys", "address", n]));
const kp = (n: string) => (keys[n] ??= Keypair.fromSecret(stellar(["keys", "secret", n])));

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}
const naira = (units: bigint) => `₦${(Number(units / (UNIT / 100n)) / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
const decimal = (units: bigint) => `${units / UNIT}.${(units % UNIT).toString().padStart(7, "0")}`;
const toUnits = (s: string) => {
  const [w, f = ""] = s.split(".");
  return BigInt(w) * UNIT + BigInt((f + "0000000").slice(0, 7));
};

// ---------------------------------------------------------------------------
// Journal: hash on disk before the network sees the transaction
// ---------------------------------------------------------------------------

type Entry = { label: string; hash: string; xdr: string; maxTime: number; status: "pending" | "done" | "dropped" };
const journal: Entry[] = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : [];
const saveJournal = () => writeFileSync(STATE_FILE, JSON.stringify(journal.slice(-200), null, 2) + "\n");

async function resolvePending() {
  for (const e of journal.filter((x) => x.status === "pending")) {
    const res = await server.getTransaction(e.hash);
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      e.status = "done";
      console.log(`  earlier run: ${e.label} did go through (${e.hash.slice(0, 8)})`);
    } else if (res.status === rpc.Api.GetTransactionStatus.FAILED || Date.now() / 1000 > e.maxTime + 10) {
      e.status = "dropped";
      console.log(`  earlier run: ${e.label} provably not applied; recomputing`);
    } else {
      // Not seen and not expired: the same signed envelope (same hash) is safe to resend.
      console.log(`  earlier run: ${e.label} still pending; resending the same envelope`);
      await send(e.label, TransactionBuilder.fromXDR(e.xdr, PASSPHRASE) as Transaction, e);
    }
    saveJournal();
  }
}

async function send(label: string, tx: Transaction, existing?: Entry): Promise<string> {
  const hash = tx.hash().toString("hex");
  const entry = existing ?? { label, hash, xdr: tx.toXDR(), maxTime: Number(tx.timeBounds?.maxTime ?? 0), status: "pending" as const };
  if (!existing) journal.push(entry);
  saveJournal();
  const t0 = Date.now();
  try {
    const res = await submitTransaction(server, tx, { attempts: 3, baseDelayMs: 1000 });
    if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`${label}: ${hash} failed on-chain`);
  } catch (e) {
    if (e instanceof OutcomeUnknownError) throw new Error(`${label}: ${hash} not found yet; rerun to look it up again`);
    throw e;
  }
  entry.status = "done";
  saveJournal();
  console.log(`  ✓ ${label}  ${((Date.now() - t0) / 1000).toFixed(1)} s  ${EXPERT}/tx/${hash}`);
  return hash;
}

async function classic(source: string, ops: ReturnType<typeof Operation.payment>[], feeBump = false): Promise<Transaction> {
  const account = await horizon.loadAccount(pub(source));
  const b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE }).setTimeout(60);
  for (const op of ops) b.addOperation(op);
  const tx = b.build();
  tx.sign(kp(source));
  return feeBump ? bumped(tx) : tx;
}

/** Funmi holds no XLM: the partner pays the network fee (fee bump), as chain-worker does. */
function bumped(inner: Transaction): Transaction {
  const outer = TransactionBuilder.buildFeeBumpTransaction(kp("partner"), (BigInt(inner.fee) + 1000n).toString(), inner, PASSPHRASE);
  outer.sign(kp("partner"));
  return outer as unknown as Transaction;
}

async function assetBalance(name: string, asset: Asset): Promise<bigint> {
  const a = await horizon.loadAccount(pub(name));
  const line = a.balances.find((b) => "asset_code" in b && b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer());
  return line ? toUnits(line.balance) : -1n;
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

let lib: typeof PlusClient;
const CONTRACT_ID = process.env.PLUS_CONTRACT_ID || stellar(["contract", "alias", "show", "plus", "--network", "testnet"]);
const clients: Record<string, PlusClient.Client> = {};
function plus(name: string): PlusClient.Client {
  clients[name] ??= new lib.Client({
    contractId: CONTRACT_ID,
    networkPassphrase: PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: pub(name),
    ...basicNodeSigner(kp(name), PASSPHRASE),
  });
  return clients[name];
}
type Assembled = { simulation?: unknown; sign: (o?: { force?: boolean }) => Promise<void>; signed?: Transaction; result: unknown };
async function signed(at: Assembled, feeBump = false): Promise<Transaction> {
  const sim = at.simulation as rpc.Api.SimulateTransactionResponse | undefined;
  if (sim && rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`);
  await at.sign({ force: true });
  if (!at.signed) throw new Error("not signed");
  return feeBump ? bumped(at.signed) : at.signed;
}
const unwrap = <T>(r: unknown): T => {
  const v = (r as { result: unknown }).result as { unwrap?: () => unknown };
  return (typeof v?.unwrap === "function" ? v.unwrap() : v) as T;
};
type ChainGroup = { members: { tag: string; values: [string] }[]; contributed: boolean[]; amount: bigint; turn: number; next_due: bigint; pot: bigint };
type ChainAdvance = { owed: bigint } | undefined;

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

async function expireWaiting(userId: string) {
  const now = new Date().toISOString();
  const actions = must(await db.from("pending_actions").update({ status: "expired", updated_at: now })
    .eq("user_id", userId).eq("status", "pending").select("id"), "expire actions") as unknown[];
  const cash = must(await db.from("cash_events").update({ status: "expired", updated_at: now })
    .eq("user_id", userId).eq("status", "awaiting_user").select("id"), "expire cash-ins") as unknown[];
  console.log(`  pending actions expired: ${actions.length}; cash-ins waiting for her expired: ${cash.length}`);
}

async function addTx(row: { user_id: string; kind: string; source: string; amount: bigint; hash: string }) {
  must(await db.from("transactions").upsert({
    user_id: row.user_id, market_id: "ng", kind: row.kind, source: row.source, amount: row.amount.toString(),
    currency: "NGN", rail: "stellar", ref: `demo_reset:${row.hash}`, tx_hash: row.hash, chain_tx_hash: row.hash, status: "completed",
  }, { onConflict: "rail,ref", ignoreDuplicates: true }), "transaction row");
}

async function waitForOutbox(signers: string[]) {
  for (let i = 0; i < 45; i++) {
    const { count } = await db.from("chain_outbox").select("id", { count: "exact", head: true })
      .in("signer", signers).in("status", ["queued", "submitted"]);
    if (!count) return;
    if (i === 0) console.log(`  waiting for ${count} queued Stellar transaction(s) to finish first…`);
    await sleep(2000);
  }
  throw new Error("chain_outbox still busy after 90 s; run again in a minute");
}

async function asUser(email: string) {
  const c = createClient(url, process.env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password: process.env.VITE_DEMO_LOGIN_PASSWORD! });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  return async (tool: string) => {
    const r = await fetch(`${url}/functions/v1/agent-tools/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${data.session.access_token}` },
      body: "{}",
    });
    return await r.json() as Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Nigeria: Funmi
// ---------------------------------------------------------------------------

/**
 * anchor_ng: the partner bank's distribution account. Its key is made inside Supabase and goes
 * straight into Vault (scheduler/provision); this script only ever sees its public address. The
 * issuer keeps it funded so "simulate transfer received" always has NGNT to send.
 */
async function ensureAnchor(NGNT: Asset) {
  const call = async () => {
    const res = await fetch(`${url}/functions/v1/scheduler/provision`, {
      method: "POST",
      headers: { "x-plus-secret": process.env.AGENT_SHARED_SECRET!, "content-type": "application/json" },
      body: JSON.stringify({ signer: "anchor_ng" }),
    });
    return await res.json() as { ok: boolean; pub: string; status: string; tx_hash: string | null; error?: string };
  };
  let a = await call();
  if (!a.ok) throw new Error(`anchor provision: ${a.error}`);
  for (let i = 0; i < 30 && a.status !== "done"; i++) {
    await sleep(2000);
    a = await call();
  }
  if (a.status !== "done") throw new Error(`anchor wallet not created yet (status ${a.status}); run again`);
  const acct = await horizon.loadAccount(a.pub);
  const line = acct.balances.find((b) => "asset_code" in b && b.asset_code === "NGNT" && b.asset_issuer === NGNT.getIssuer());
  const have = line ? toUnits(line.balance) : 0n;
  if (have < ANCHOR_MIN * UNIT) {
    await send(`issuer funds the partner bank's anchor to ${naira(ANCHOR_MIN * UNIT)}`,
      await classic("issuer", [Operation.payment({ destination: a.pub, asset: NGNT, amount: decimal(ANCHOR_MIN * UNIT - have) })]));
  } else {
    console.log(`  anchor_ng ${a.pub.slice(0, 6)}… holds ${naira(have)}`);
  }
}

async function resetNigeria() {
  const NGNT = new Asset("NGNT", pub("issuer"));
  const NGNT_SAC = NGNT.contractId(PASSPHRASE);
  const funmi = must(await db.from("users").select("id, stellar_pub").eq("stellar_pub", pub("funmi")).single(), "Funmi") as { id: string };

  console.log("\n1. Waiting actions");
  await expireWaiting(funmi.id);
  await waitForOutbox(["funmi", "agent_ng", "partner", "anchor_ng"]);

  console.log("\n2. Unused cash-out codes");
  const codes = must(await db.from("cash_out_codes").select("id, amount, create_outbox_id").eq("user_id", funmi.id).eq("status", "issued"), "codes") as
    { id: string; amount: number; create_outbox_id: number | null }[];
  for (const c of codes) {
    const out = c.create_outbox_id
      ? must(await db.from("chain_outbox").select("status, result").eq("id", c.create_outbox_id).maybeSingle(), "create row") as { status: string; result: { balance_id?: string } | null } | null
      : null;
    const balanceId = out?.status === "done" ? out.result?.balance_id : undefined;
    if (balanceId) {
      const exists = await horizon.claimableBalances().claimableBalance(balanceId).call().then(() => true, () => false);
      if (exists) await send(`Mama Bisi takes back an unused ₦${(c.amount / 100).toLocaleString("en-NG")} cash-out`, await classic("agent_ng", [Operation.claimClaimableBalance({ balanceId }) as ReturnType<typeof Operation.payment>]));
    }
    must(await db.from("cash_out_codes").update({ status: "returned", updated_at: new Date().toISOString() }).eq("id", c.id).eq("status", "issued"), "code returned");
  }
  console.log(`  unused codes closed: ${codes.length}`);

  console.log("\n3. Advance");
  const adv = unwrap<ChainAdvance>(await plus("partner").advance_of({ party: { tag: "Account", values: [pub("funmi")] } }));
  if (adv && adv.owed > 0n) {
    const owed = BigInt(adv.owed);
    if ((await assetBalance("partner", NGNT)) < owed) {
      await send("issuer tops up the partner", await classic("issuer", [Operation.payment({ destination: pub("partner"), asset: NGNT, amount: decimal(owed) })]));
    }
    const inHash = await send(`partner settles Funmi's advance: sends her ${naira(owed)}`,
      await classic("partner", [Operation.payment({ destination: pub("funmi"), asset: NGNT, amount: decimal(owed) })]));
    await addTx({ user_id: funmi.id, kind: "adjustment", source: "partner_settles_advance", amount: owed / KOBO_PER_UNIT, hash: inHash });
    const repayHash = await send(`Funmi repays ${naira(owed)} (contract repay, fee-bumped)`,
      await signed(await plus("funmi").repay({ user: pub("funmi"), amount: owed }, { timeoutInSeconds: 60 }) as unknown as Assembled, true));
    await addTx({ user_id: funmi.id, kind: "repay", source: "demo_reset", amount: -owed / KOBO_PER_UNIT, hash: repayHash });
  } else {
    console.log("  no advance open");
  }

  console.log("\n4. Funmi's wallet and Mama Bisi's float");
  for (const [name, target, userId] of [["funmi", FUNMI_START * UNIT, funmi.id], ["agent_ng", FLOAT_START * UNIT, null]] as const) {
    const have = await assetBalance(name, NGNT);
    const who = name === "funmi" ? "Funmi" : "Mama Bisi";
    if (have === target) {
      console.log(`  ${who} already has ${naira(target)}`);
      continue;
    }
    const diff = target - have;
    const hash = diff > 0n
      ? await send(`issuer tops ${who} up by ${naira(diff)} to ${naira(target)}`,
        await classic("issuer", [Operation.payment({ destination: pub(name), asset: NGNT, amount: decimal(diff) })]))
      : await send(`${who} returns ${naira(-diff)} to the issuer, leaving ${naira(target)}`,
        await classic(name, [Operation.payment({ destination: pub("issuer"), asset: NGNT, amount: decimal(-diff) })], name === "funmi"));
    if (userId) await addTx({ user_id: userId, kind: "adjustment", source: "demo_reset", amount: diff / KOBO_PER_UNIT, hash });
  }

  console.log("\n4b. The partner bank's anchor (pays bank transfers into wallets)");
  await ensureAnchor(NGNT);

  console.log("\n5. Ajo round");
  const links = must(await db.from("group_members").select("group_id, groups!inner(id, name, onchain_id, mode, amount, period_secs, created_at)")
    .eq("user_id", funmi.id).eq("groups.mode", "pooled").not("groups.onchain_id", "is", null), "groups") as unknown as
    { groups: { id: string; name: string; onchain_id: number; amount: number; period_secs: number; created_at: string } }[];
  const current = links.map((l) => l.groups).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!current) throw new Error("Funmi is in no ajo; run pnpm seed:db");
  const g = unwrap<ChainGroup>(await plus("partner").group({ group_id: current.onchain_id }));
  const members = g.members.map((m) => m.values[0]);
  const mine = members.indexOf(pub("funmi"));
  if (!g.contributed[mine]) {
    console.log(`  ${current.name} (group ${current.onchain_id}): she hasn't paid this round; nothing to do`);
  } else {
    const names = ["amaka", "funmi", "ng_member2", "ng_member3", "ng_member4"];
    const nameOf = (p: string) => names.find((n) => pub(n) === p);
    if (members.some((m) => !nameOf(m))) throw new Error("ajo member without a local stellar identity");
    const amount = BigInt(g.amount);
    const createHash_ = await send(`Amaka starts a new ${current.name} round (group_create, 1 day)`,
      await signed(await plus("amaka").group_create({
        organizer: pub("amaka"),
        members: members.map((m) => ({ tag: "Account", values: [m] })) as PlusClient.Party[],
        asset: NGNT_SAC,
        amount,
        period_secs: BigInt(current.period_secs),
        pooled: true,
      }, { timeoutInSeconds: 60 }) as unknown as Assembled));
    const tx = await server.getTransaction(createHash_);
    const newId = Number(tx.status === rpc.Api.GetTransactionStatus.SUCCESS && tx.returnValue ? scValToNative(tx.returnValue) : NaN);
    if (!Number.isInteger(newId)) throw new Error("could not read the new group id");
    for (const m of members.filter((p) => p !== pub("funmi"))) {
      const n = nameOf(m)!;
      if ((await assetBalance(n, NGNT)) < amount) {
        await send(`issuer gives ${n} ₦5,000 for the ajo`, await classic("issuer", [Operation.payment({ destination: m, asset: NGNT, amount: "5000" })]));
      }
      await send(`${n} pays ${naira(amount)} into the new round`, await signed(await plus(n).group_contribute({ user: m, group_id: newId }, { timeoutInSeconds: 60 }) as unknown as Assembled));
    }
    const fresh = unwrap<ChainGroup>(await plus("partner").group({ group_id: newId }));
    const row = must(await db.from("groups").insert({
      market_id: "ng", name: current.name, mode: "pooled", onchain_id: newId, amount: current.amount,
      period_secs: current.period_secs, next_due: new Date(Number(fresh.next_due) * 1000).toISOString(),
    }).select("id").single(), "new group") as { id: string };
    const oldMembers = must(await db.from("group_members").select("user_id, member_ref, name, position").eq("group_id", current.id).order("position"), "members") as Record<string, unknown>[];
    must(await db.from("group_members").insert(oldMembers.map((m) => ({ ...m, group_id: row.id }))), "new members");
    console.log(`  new round: group ${newId}; ${current.name} (group ${current.onchain_id}) keeps its history and still pays out when due`);
  }

  // Refresh the balance cache now (the scheduler does it every minute anyway).
  await fetch(`${url}/functions/v1/scheduler`, { method: "POST", headers: { "x-plus-secret": process.env.AGENT_SHARED_SECRET! }, body: "{}" });

  console.log("\nFunmi's starting state (read through the app's own tools)");
  const t = await asUser("demo-funmi@example.com");
  const [bal, ajo, advance, outs] = await Promise.all([t("get_balance"), t("group_status"), t("advance_status"), t("cash_outs")]);
  const { count: waiting } = await db.from("pending_actions").select("id", { count: "exact", head: true }).eq("user_id", funmi.id).eq("status", "pending");
  console.log(`  wallet     ${bal.text}`);
  console.log(`  ajo        ${ajo.text}`);
  console.log(`  advance    ${advance.text}`);
  console.log(`  cash-outs  ${((outs.cash_outs ?? []) as { status: string }[]).filter((c) => c.status === "issued").length} unused codes`);
  console.log(`  waiting    ${waiting ?? 0} pending actions`);
  console.log(`  Mama Bisi  float ${naira(await assetBalance("agent_ng", NGNT))}`);
  console.log(`  wallet on Stellar Expert: ${EXPERT}/account/${pub("funmi")}`);
}

// ---------------------------------------------------------------------------
// India: Selvi
// ---------------------------------------------------------------------------

async function resetIndia() {
  const refHex = createHash("sha256").update("plus-demo:selvi", "utf8").digest("hex");
  const selvi = must(await db.from("users").select("id, ref_hash").eq("ref_hash", refHex).single(), "Selvi") as { id: string; ref_hash: string };

  console.log("\n1. Waiting actions");
  await expireWaiting(selvi.id);

  console.log("\n2. Advance");
  const party = { tag: "Ref", values: [Buffer.from(refHex, "hex")] } as PlusClient.Party;
  const adv = unwrap<ChainAdvance>(await plus("partner").advance_of({ party }));
  if (adv && adv.owed > 0n) {
    await send(`partner settles Selvi's advance (${BigInt(adv.owed) / UNIT} rupees, record_repayment)`,
      await signed(await plus("partner").record_repayment({
        user_ref: Buffer.from(refHex, "hex"),
        amount: BigInt(adv.owed),
        payment_ref: createHash("sha256").update(`${runRef}:selvi:advance`).digest(),
      }, { timeoutInSeconds: 60 }) as unknown as Assembled));
  } else {
    console.log("  no advance open");
  }

  console.log("\n3. Simulated bank account");
  const acct = must(await db.rpc("demo_set_sim_balance", { p_user_id: selvi.id, p_spend: SELVI_SPEND.toString(), p_saved: SELVI_SAVED.toString(), p_ref: runRef }), "sim balance") as
    { balance_paise: number; savings_paise: number };
  console.log(`  ₹${acct.balance_paise / 100} to spend, ₹${acct.savings_paise / 100} saved`);

  console.log("\n4. Seettu round");
  const link = must(await db.from("group_members").select("group_id, groups!inner(id, name, period_secs, round_started_at)").eq("user_id", selvi.id).limit(1).maybeSingle(), "seettu") as
    { groups: { id: string; name: string; period_secs: number; round_started_at: string | null } } | null;
  if (link) {
    const g = link.groups;
    const since = new Date(Math.max(Date.now() - g.period_secs * 1000, g.round_started_at ? Date.parse(g.round_started_at) : 0)).toISOString();
    const { count } = await db.from("transactions").select("id", { count: "exact", head: true })
      .eq("user_id", selvi.id).eq("kind", "group_contribution").eq("source", g.id).gte("created_at", since);
    if (count) {
      must(await db.from("groups").update({ round_started_at: new Date().toISOString() }).eq("id", g.id), "new round");
      console.log(`  ${g.name}: new round started (her earlier contributions stay on her record)`);
    } else {
      console.log(`  ${g.name}: she hasn't paid this round; nothing to do`);
    }
  }

  console.log("\nSelvi's starting state (read through the app's own tools)");
  const t = await asUser("demo-selvi@example.com");
  const [bal, seettu, advance] = await Promise.all([t("get_balance"), t("group_status"), t("advance_status")]);
  const { count: waiting } = await db.from("pending_actions").select("id", { count: "exact", head: true }).eq("user_id", selvi.id).eq("status", "pending");
  console.log(`  bank       ${bal.text}`);
  console.log(`  seettu     ${seettu.text}`);
  console.log(`  advance    ${advance.text}`);
  console.log(`  waiting    ${waiting ?? 0} pending actions`);
}

// ---------------------------------------------------------------------------

async function main() {
  if ((process.env.STELLAR_NETWORK ?? "testnet") !== "testnet") throw new Error("testnet only");
  lib = await import("@plus/client");
  console.log(`Demo reset: ${market === "ng" ? "Funmi (Nigeria)" : "Selvi (India)"} · contract ${CONTRACT_ID.slice(0, 8)}… · testnet`);
  await resolvePending();
  if (market === "ng") await resetNigeria();
  else await resetIndia();
}

main().catch((e) => {
  console.error(`\ndemo:reset failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
