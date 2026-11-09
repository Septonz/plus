// pnpm seed:db — re-runnable demo data for the dev Supabase project.
//
// India: Selvi (wa_phone from DEMO_SELVI_PHONE, so you can play her on WhatsApp), her simulated
// bank account (Rs 2,350 to spend, Rs 1,415 saved, built only through sim_credit / sim_debit /
// sim_move_to_savings with fixed refs, so reruns change nothing), two payees, helper Meena,
// one cash-in awaiting Selvi's confirmation (recorded through helper_record_cash_in), and the
// seettu mirrored from the contract with Meena as its leader.
// App demo logins (Supabase Auth): demo-selvi@example.com and demo-meena@example.com, linked through
// users.auth_user_id / helpers.auth_user_id, app_metadata.demo = true. One shared demo password,
// VITE_DEMO_LOGIN_PASSWORD in the root .env.local (generated on first run, gitignored, never printed).
// Production login is phone OTP plus PIN; these demo logins exist only on the dev project.
// Nigeria: Funmi (demo user; her Stellar wallet is her account, custodial key in the Supabase
// secret STELLAR_SECRET_FUNMI), Mama Bisi (cash agent agent_ng, key in STELLAR_SECRET_AGENT_NG),
// payee Iya Tunde, Amaka, the ajo and the Bodija Market Ajo mirrored from the contract, and
// Funmi's eight weeks of on-chain history imported as transactions (real hashes and ledger times).
// Demo logins demo-funmi@example.com and demo-mamabisi@example.com.
//
// Demo user refs are public (sha256("plus-demo:<name>")); real users get userRef(phone) HMAC.
// Requires: `pnpm seed` (Stellar) has run; Supabase CLI logged in. Dev project only.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatMoney, getMarket } from "../packages/markets/src/index.ts";
import { adminClient, loadLocalEnv, ROOT } from "./lib/supabase-admin.ts";

loadLocalEnv();

const RPC_URL = "https://soroban-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const DECIMALS_TO_MINOR = 100_000n; // 7 on-chain decimals -> 2 (paise / kobo)
const E164 = /^\+[1-9][0-9]{7,14}$/;

// Fictional demo numbers (not real people). Selvi's comes from DEMO_SELVI_PHONE.
const MEENA_PHONE = "+910000000201";
const AMAKA_PHONE = "+2340000000301";
const AGENT_NG_PHONE = "+2340000000401";
const FUNMI_PHONE = "+2340000000501";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

const SEETTU_NAMES = ["selvi", "lakshmi", "meena", "kavitha", "revathi"];
const AJO_NAMES: Record<string, string> = { amaka: "Amaka", ng_member2: "Tunde", ng_member3: "Halima", funmi: "Funmi", ng_member4: "Kemi" };

const { db } = adminClient();
const refHex = (name: string) => createHash("sha256").update(`plus-demo:${name}`, "utf8").digest("hex");
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const stellar = (args: string[]) =>
  execFileSync("stellar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

async function rpc(fn: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}(${String(args.p_ref)}): ${error.message}`);
  return data as { id: string; amount: number; created_at: string };
}

// ---------------------------------------------------------------------------
// Contract reads (views, simulated only)
// ---------------------------------------------------------------------------

type Party = { tag: "Ref"; values: [Buffer] } | { tag: "Account"; values: [string] };
type Group = { members: Party[]; amount: bigint; period_secs: bigint; next_due: bigint; pooled: boolean };

async function readGroup(contractId: string, id: number): Promise<Group> {
  const lib = await import("@plus/client");
  const client = new lib.Client({ contractId, networkPassphrase: PASSPHRASE, rpcUrl: RPC_URL });
  const at = await client.group({ group_id: id });
  // deno-lint-ignore no-explicit-any
  const r = at.result as any;
  return (typeof r?.unwrap === "function" ? r.unwrap() : r) as Group;
}

async function mirrorGroup(opts: {
  contractId: string;
  onchainId: number;
  market: "in" | "ng";
  name: string;
  memberName: (p: Party) => { ref: string; name: string; userId: string | null };
  leaderHelperId?: string;
}) {
  const g = await readGroup(opts.contractId, opts.onchainId);
  const row = check(
    await db.from("groups").upsert({
      market_id: opts.market,
      name: opts.name,
      mode: g.pooled ? "pooled" : "record",
      onchain_id: opts.onchainId,
      amount: Number(BigInt(g.amount) / DECIMALS_TO_MINOR),
      period_secs: Number(g.period_secs),
      next_due: new Date(Number(g.next_due) * 1000).toISOString(),
      ...(opts.leaderHelperId ? { leader_helper_id: opts.leaderHelperId } : {}),
    }, { onConflict: "onchain_id" }).select("id").single(),
    `group ${opts.name}`,
  );
  const members = g.members.map((p, position) => {
    const m = opts.memberName(p);
    return { group_id: row.id, position, member_ref: m.ref, name: m.name, user_id: m.userId };
  });
  check(await db.from("group_members").upsert(members, { onConflict: "group_id,position" }), `${opts.name} members`);
  console.log(`  group ${opts.name}: on-chain ${opts.onchainId}, ${members.length} members, ` +
    `${formatMoney(BigInt(g.amount) / DECIMALS_TO_MINOR, opts.market)} every ${Number(g.period_secs) / 86400} day(s)`);
}

// ---------------------------------------------------------------------------

async function upsertUser(match: { col: "ref_hash" | "wa_phone"; val: string }, row: Record<string, unknown>) {
  const existing = check(
    await db.from("users").select("id").eq(match.col, match.val).maybeSingle(),
    "find user",
  ) as { id: string } | null;
  if (existing) {
    // Identity fields only; settings the user changed in the demo (auto-save, KYC) stay.
    const { auto_save_bps: _a, kyc_tier: _k, ...identity } = row;
    check(await db.from("users").update(identity).eq("id", existing.id), "update user");
    return existing.id;
  }
  return (check(await db.from("users").insert(row).select("id").single(), "insert user") as { id: string }).id;
}

async function upsertHelper(row: Record<string, unknown>) {
  return (check(
    await db.from("helpers").upsert(row, { onConflict: "phone" }).select("id").single(),
    `helper ${row.name}`,
  ) as { id: string }).id;
}

// ---------------------------------------------------------------------------
// Demo logins
// ---------------------------------------------------------------------------

export const DEMO_SELVI_EMAIL = "demo-selvi@example.com";
export const DEMO_MEENA_EMAIL = "demo-meena@example.com";
export const DEMO_FUNMI_EMAIL = "demo-funmi@example.com";
export const DEMO_MAMA_BISI_EMAIL = "demo-mamabisi@example.com";

/** When a transaction closed, from Horizon (so imported history shows the real on-chain time). */
async function ledgerTime(hash: string): Promise<string> {
  const res = await fetch(`${HORIZON_URL}/transactions/${hash}`);
  if (!res.ok) throw new Error(`horizon ${res.status} for ${hash}`);
  return (await res.json() as { created_at: string }).created_at;
}

function demoPassword(): string {
  const existing = process.env.VITE_DEMO_LOGIN_PASSWORD;
  if (existing) return existing;
  const pw = randomBytes(18).toString("base64url");
  appendFileSync(join(ROOT, ".env.local"), `
# Demo app logins (dev project only), written by pnpm seed:db
VITE_DEMO_LOGIN_PASSWORD=${pw}
`);
  process.env.VITE_DEMO_LOGIN_PASSWORD = pw;
  console.log("  wrote VITE_DEMO_LOGIN_PASSWORD to .env.local (value not shown)");
  return pw;
}

async function demoLogin(email: string, password: string, role: "user" | "helper"): Promise<string> {
  let id: string | undefined;
  for (let page = 1; page <= 10 && !id; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`list auth users: ${error.message}`);
    id = data.users.find((u) => u.email === email)?.id;
    if (data.users.length < 200) break;
  }
  const attrs = { password, email_confirm: true, app_metadata: { demo: true, plus_role: role } };
  if (id) {
    const { error } = await db.auth.admin.updateUserById(id, attrs);
    if (error) throw new Error(`update ${email}: ${error.message}`);
    return id;
  }
  const { data, error } = await db.auth.admin.createUser({ email, ...attrs });
  if (error) throw new Error(`create ${email}: ${error.message}`);
  return data.user.id;
}

async function main() {
  const selviPhone = process.env.DEMO_SELVI_PHONE?.replace(/[\s-]/g, "");
  if (!selviPhone || !E164.test(selviPhone)) {
    throw new Error("set DEMO_SELVI_PHONE to your WhatsApp number in international format, e.g. +919876543210");
  }
  const stateFile = join(ROOT, "scripts", ".seed-state.json");
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
  const contractId: string = process.env.PLUS_CONTRACT_ID || state?.contractId ||
    stellar(["contract", "alias", "show", "plus", "--network", "testnet"]);
  const seettuId = Number(state?.steps?.["seettu:create"]?.value ?? 0);
  const ajoId = Number(state?.steps?.["ajo:create"]?.value ?? 1);

  // ----- India ---------------------------------------------------------------
  console.log("India");
  const india = getMarket("in");
  const selvi = await upsertUser({ col: "ref_hash", val: refHex("selvi") }, {
    market_id: "in",
    wa_phone: selviPhone,
    name: "Selvi",
    language: "ta",
    kyc_tier: 1,
    ref_hash: refHex("selvi"),
    auto_save_bps: india.autoSave.defaultBps,
  });
  console.log(`  user Selvi (${selviPhone.slice(0, 3)}…${selviPhone.slice(-2)})`);

  check(
    await db.from("sim_bank_accounts").upsert(
      { user_id: selvi, bank_name: "Partner Bank (simulated)" },
      { onConflict: "user_id", ignoreDuplicates: true },
    ),
    "sim account",
  );

  const meena = await upsertHelper({
    market_id: "in",
    name: "Meena",
    phone: MEENA_PHONE,
    role: "group_leader",
    daily_limit: india.helperFloatLimit * 100,
    active: true,
  });
  console.log(`  helper Meena (group leader, daily limit ${formatMoney(BigInt(india.helperFloatLimit * 100), "in")})`);

  const password = demoPassword();
  const selviLogin = await demoLogin(DEMO_SELVI_EMAIL, password, "user");
  const meenaLogin = await demoLogin(DEMO_MEENA_EMAIL, password, "helper");
  check(await db.from("users").update({ auth_user_id: selviLogin }).eq("id", selvi), "link Selvi login");
  check(await db.from("helpers").update({ auth_user_id: meenaLogin }).eq("id", meena), "link Meena login");
  console.log(`  app logins: ${DEMO_SELVI_EMAIL} (Selvi), ${DEMO_MEENA_EMAIL} (Meena)`);

  // Money: Rs 4,000 in (10% auto-saved), Rs 1,015 moved to savings, Rs 235 paid.
  // -> Rs 2,350 to spend, Rs 1,415 saved. Fixed refs make every step apply once.
  const cashIn = check(
    await db.from("cash_events").select("id").eq("user_id", selvi).eq("helper_id", meena)
      .eq("status", "confirmed").eq("amount", 120000).eq("rail_ref", "seed:selvi:cash:1").maybeSingle(),
    "find cash_event",
  ) as { id: string } | null;
  const cashEventId = cashIn?.id ?? (check(
    await db.from("cash_events").insert({
      helper_id: meena,
      user_id: selvi,
      direction: "in",
      amount: 120000,
      status: "confirmed",
      rail_ref: "seed:selvi:cash:1",
    }).select("id").single(),
    "cash_event",
  ) as { id: string }).id;

  await rpc("sim_credit", { p_user_id: selvi, p_amount: 100000, p_source: "state_transfer", p_ref: "seed:selvi:state_transfer:1" });
  await rpc("sim_credit", { p_user_id: selvi, p_amount: 180000, p_source: "wages", p_ref: "seed:selvi:wages:1" });
  await rpc("sim_credit", { p_user_id: selvi, p_amount: 120000, p_source: "cash", p_ref: cashEventId });
  await rpc("sim_move_to_savings", { p_user_id: selvi, p_amount: 101500, p_ref: "seed:selvi:save:1" });
  await rpc("sim_debit", { p_user_id: selvi, p_amount: 23500, p_kind: "pay", p_ref: "seed:selvi:pay:1" });

  const acct = check(
    await db.from("sim_bank_accounts").select("balance_paise, savings_paise").eq("user_id", selvi).single(),
    "read account",
  ) as { balance_paise: number; savings_paise: number };
  const expected = acct.balance_paise === 235000 && acct.savings_paise === 141500;
  console.log(`  bank: ${formatMoney(BigInt(acct.balance_paise), "in")} to spend, ` +
    `${formatMoney(BigInt(acct.savings_paise), "in")} saved${expected ? "" : "  (differs from the seed: demo activity since)"}`);

  check(
    await db.from("payees").upsert([
      { user_id: selvi, name: "flower wholesaler", upi_handle: "madurai.flowers@upisim" },
      { user_id: selvi, name: "medical shop", upi_handle: "medical.shop@upisim" },
    ], { onConflict: "user_id,name" }),
    "payees",
  );
  console.log("  payees: flower wholesaler, medical shop");

  const nameByRef = Object.fromEntries(SEETTU_NAMES.map((n) => [refHex(n), n]));
  await mirrorGroup({
    contractId,
    onchainId: seettuId,
    market: "in",
    name: india.groupSavings.localName,
    memberName: (p) => {
      const ref = p.tag === "Ref" ? Buffer.from(p.values[0]).toString("hex") : p.values[0];
      const n = nameByRef[ref];
      return { ref, name: n ? cap(n) : "Member", userId: n === "selvi" ? selvi : null };
    },
    leaderHelperId: meena,
  });

  // One cash-in awaiting Selvi's answer (Home screen and what_arrived), made exactly the way the
  // helper page makes it. Cash-ins from before the action functions (no cash_event_id) expire.
  const stale = check(
    await db.from("pending_actions").select("id").eq("user_id", selvi).eq("kind", "confirm_cash_in").eq("status", "pending")
      .is("params->>cash_event_id", null),
    "find old cash-ins",
  ) as { id: string }[];
  for (const pa of stale) {
    check(await db.from("cash_events").update({ status: "expired" }).eq("pending_action_id", pa.id).eq("status", "awaiting_user"), "expire old cash_event");
    check(await db.from("pending_actions").update({ status: "expired", result: { ok: false, error: "expired" } }).eq("id", pa.id), "expire old cash-in");
  }
  const ce = await rpc("helper_record_cash_in", {
    p_helper_id: meena,
    p_user_id: selvi,
    p_amount: 50000,
    p_idempotency_key: "seed-selvi-cash-in-awaiting-v2",
    p_readback: `Meena says you gave her ${formatMoney(50000n, "in")} in cash. Is that right?`,
  }) as unknown as { status: string };
  console.log(`  cash-in: Meena recorded Rs 500 (${ce.status === "awaiting_user" ? "awaiting Selvi" : ce.status})`);

  // ----- Nigeria -------------------------------------------------------------
  console.log("Nigeria");
  const nigeria = getMarket("ng");
  const pubs = Object.fromEntries(
    ["amaka", "ng_member2", "ng_member3", "ng_member4", "agent_ng", "funmi", "iya_tunde"].map((n) => [n, stellar(["keys", "address", n])]),
  );
  const amaka = await upsertUser({ col: "wa_phone", val: AMAKA_PHONE }, {
    market_id: "ng",
    wa_phone: AMAKA_PHONE,
    name: "Amaka",
    language: "en",
    kyc_tier: 1,
    stellar_pub: pubs.amaka,
    auto_save_bps: nigeria.autoSave.defaultBps,
  });
  console.log("  user Amaka");

  const funmi = await upsertUser({ col: "wa_phone", val: FUNMI_PHONE }, {
    market_id: "ng",
    wa_phone: FUNMI_PHONE,
    name: "Funmi",
    language: "en", // Nigerian Pidgin by default (en covers Pidgin); Yoruba if she speaks it
    kyc_tier: 1,
    stellar_pub: pubs.funmi,
    secret_name: "STELLAR_SECRET_FUNMI",
    is_demo: true,
    auto_save_bps: 0,
  });
  console.log(`  user Funmi (wallet ${pubs.funmi.slice(0, 6)}…, key in Supabase secret STELLAR_SECRET_FUNMI)`);

  // Mama Bisi is the cash agent agent_ng (this row was "Agent Musa" before the Nigeria pivot).
  const mamaBisi = await upsertHelper({
    market_id: "ng",
    name: "Mama Bisi",
    phone: AGENT_NG_PHONE,
    role: "agent",
    stellar_pub: pubs.agent_ng,
    secret_name: "STELLAR_SECRET_AGENT_NG",
    daily_limit: nigeria.helperFloatLimit * 100,
    active: true,
  });
  console.log(`  helper Mama Bisi (agent, float on Stellar, daily limit ${formatMoney(BigInt(nigeria.helperFloatLimit * 100), "ng")})`);

  const funmiLogin = await demoLogin(DEMO_FUNMI_EMAIL, password, "user");
  const bisiLogin = await demoLogin(DEMO_MAMA_BISI_EMAIL, password, "helper");
  check(await db.from("users").update({ auth_user_id: funmiLogin }).eq("id", funmi), "link Funmi login");
  check(await db.from("helpers").update({ auth_user_id: bisiLogin }).eq("id", mamaBisi), "link Mama Bisi login");
  console.log(`  app logins: ${DEMO_FUNMI_EMAIL} (Funmi), ${DEMO_MAMA_BISI_EMAIL} (Mama Bisi)`);

  check(
    await db.from("payees").upsert(
      { user_id: funmi, name: "Iya Tunde (tomato wholesaler)", stellar_address: pubs.iya_tunde },
      { onConflict: "user_id,name" },
    ),
    "Funmi payee",
  );
  console.log("  payee: Iya Tunde (tomato wholesaler), Stellar wallet");

  const grantHash: string | undefined = state?.steps?.["ngnt:issue"]?.hash;
  if (grantHash) {
    check(
      await db.from("transactions").upsert({
        user_id: amaka,
        market_id: "ng",
        kind: "incoming",
        source: "deposit",
        amount: 50_000 * 100,
        currency: "NGN",
        rail: "stellar",
        tx_hash: grantHash,
        ref: `${grantHash}:amaka`,
        status: "completed",
      }, { onConflict: "rail,ref", ignoreDuplicates: true }),
      "amaka grant",
    );
    console.log("  transaction: 50,000 NGNT deposit (Stellar seed)");
  }

  const nameByPub = Object.fromEntries(Object.entries(AJO_NAMES).map(([k, v]) => [pubs[k], v]));
  const userByPub: Record<string, string> = { [pubs.amaka]: amaka, [pubs.funmi]: funmi };
  const memberName = (p: Party) => {
    const ref = p.tag === "Account" ? p.values[0] : Buffer.from(p.values[0]).toString("hex");
    return { ref, name: nameByPub[ref] ?? "Member", userId: userByPub[ref] ?? null };
  };
  await mirrorGroup({ contractId, onchainId: ajoId, market: "ng", name: nigeria.groupSavings.localName, memberName });
  const bodijaId = Number(state?.steps?.["bodija:create"]?.value);
  if (Number.isInteger(bodijaId) && bodijaId > 0) {
    await mirrorGroup({ contractId, onchainId: bodijaId, market: "ng", name: "Bodija Market Ajo", memberName });
  } else console.log("  Bodija Market Ajo not on-chain yet: run pnpm seed");

  // Funmi's history: the seed's real transactions, imported once each (ref = seed:<tx hash>).
  const history: { key: string; kind: string; source: string; amount: number }[] = [];
  const CASH_INS = [3_000, 2_800, 3_200, 3_000, 3_400, 2_900, 3_100, 3_000];
  const AJO_ORDER = ["amaka", "funmi", "ng_member2", "ng_member3", "ng_member4"];
  for (let w = 1; w <= 8; w++) {
    history.push({ key: `funmi:w${w}:cash_in`, kind: "incoming", source: "cash", amount: CASH_INS[w - 1] * 100 });
    history.push({ key: `bodija:history:w${w}:funmi`, kind: "group_contribution", source: "Bodija Market Ajo", amount: -1_000 * 100 });
    if (AJO_ORDER[(w - 1) % AJO_ORDER.length] === "funmi") {
      history.push({ key: `bodija:history:w${w}:payout`, kind: "incoming", source: "ajo_payout", amount: AJO_ORDER.length * 1_000 * 100 });
    }
  }
  let imported = 0;
  for (const h of history) {
    const hash: string | undefined = state?.steps?.[h.key]?.hash;
    if (!hash) continue;
    const exists = check(await db.from("transactions").select("id").eq("rail", "stellar").eq("ref", `seed:${hash}`).maybeSingle(), "find history");
    if (exists) continue;
    check(
      await db.from("transactions").insert({
        user_id: funmi,
        market_id: "ng",
        kind: h.kind,
        source: h.source,
        amount: h.amount,
        currency: "NGN",
        rail: "stellar",
        tx_hash: hash,
        chain_tx_hash: hash,
        ref: `seed:${hash}`,
        status: "completed",
        created_at: await ledgerTime(hash),
      }),
      `history ${h.key}`,
    );
    imported++;
  }
  console.log(`  Funmi's on-chain history: ${imported} new of ${history.length} transactions (cash-ins from Mama Bisi, ajo contributions and payouts)`);

  console.log("\nDone. Rerun any time: fixed refs mean no money step applies twice.");
}

main().catch((err) => {
  console.error(`seed:db failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
