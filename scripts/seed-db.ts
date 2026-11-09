// pnpm seed:db — re-runnable demo data for the dev Supabase project.
//
// India: Selvi (wa_phone from DEMO_SELVI_PHONE, so you can play her on WhatsApp), her simulated
// bank account (Rs 2,350 to spend, Rs 1,415 saved, built only through sim_credit / sim_debit /
// sim_move_to_savings with fixed refs, so reruns change nothing), two payees, helper Meena,
// one cash-in awaiting Selvi's confirmation, and the seettu mirrored from the contract.
// Nigeria: Amaka and the cash agent agent_ng, the ajo mirrored from the contract, and Amaka's
// NGNT grant from the Stellar seed.
//
// Demo user refs are public (sha256("plus-demo:<name>")); real users get userRef(phone) HMAC.
// Requires: `pnpm seed` (Stellar) has run; Supabase CLI logged in. Dev project only.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

const SEETTU_NAMES = ["selvi", "lakshmi", "meena", "kavitha", "revathi"];
const AJO_NAMES: Record<string, string> = { amaka: "Amaka", ng_member2: "Tunde", ng_member3: "Halima" };

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

  // One cash-in awaiting Selvi's confirmation (what_arrived reads it out).
  const awaiting = check(
    await db.from("cash_events").select("id").eq("user_id", selvi).eq("status", "awaiting_user").limit(1),
    "find awaiting",
  ) as { id: string }[];
  if (awaiting.length === 0) {
    const pa = check(
      await db.from("pending_actions").insert({
        user_id: selvi,
        kind: "confirm_cash_in",
        params: { helper_id: meena, amount: 50000 },
        readback: `Meena says you gave her ${formatMoney(50000n, "in")} in cash to add to your account. Is that right?`,
        expires_at: new Date(Date.now() + 48 * 3600_000).toISOString(),
        created_by: "helper",
      }).select("id").single(),
      "pending_action",
    ) as { id: string };
    check(
      await db.from("cash_events").insert({
        helper_id: meena,
        user_id: selvi,
        direction: "in",
        amount: 50000,
        status: "awaiting_user",
        pending_action_id: pa.id,
      }),
      "awaiting cash_event",
    );
    console.log("  cash-in: Meena recorded Rs 500, awaiting Selvi");
  } else {
    console.log("  cash-in awaiting Selvi already present");
  }

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
  });

  // ----- Nigeria -------------------------------------------------------------
  console.log("Nigeria");
  const nigeria = getMarket("ng");
  const pubs = Object.fromEntries(["amaka", "ng_member2", "ng_member3", "agent_ng"].map((n) => [n, stellar(["keys", "address", n])]));
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
  await upsertHelper({
    market_id: "ng",
    name: "Agent Musa",
    phone: AGENT_NG_PHONE,
    role: "agent",
    stellar_pub: pubs.agent_ng,
    daily_limit: nigeria.helperFloatLimit * 100,
    active: true,
  });
  console.log(`  helper agent_ng (agent, daily limit ${formatMoney(BigInt(nigeria.helperFloatLimit * 100), "ng")})`);

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
  await mirrorGroup({
    contractId,
    onchainId: ajoId,
    market: "ng",
    name: nigeria.groupSavings.localName,
    memberName: (p) => {
      const ref = p.tag === "Account" ? p.values[0] : Buffer.from(p.values[0]).toString("hex");
      return { ref, name: nameByPub[ref] ?? "Member", userId: ref === pubs.amaka ? amaka : null };
    },
  });

  console.log("\nDone. Rerun any time: fixed refs mean no money step applies twice.");
}

main().catch((err) => {
  console.error(`seed:db failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
