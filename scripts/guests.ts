// pnpm guests:seed | guests:reset [slot|all|agents] | guests:status   (piece 12: public test mode)
// TESTNET and the dev project only.
//
// seed (idempotent; run again to finish or grow the pool):
//   1. System wallets made inside Supabase, keys straight into Vault (scheduler/provision): the
//      guests' treasury, the shop (Mama Put Canteen), the ajo members (Iya Sade, Baba Femi,
//      Mama Ifeoma), the shared demo agent (guest_agent0, "Mama Bisi") and guest agents 1 to 3.
//   2. The issuer funds the treasury (the hash is written to scripts/.guests-state.json before it is
//      submitted, and an earlier unfinished one is looked up first, never resubmitted blindly).
//   3. The shop, the ajo members and the agents as Plus rows; agents 1 to 3 get a login (no password
//      anyone knows: the app signs in with a one-time token from agent-tools/guest_start).
//   4. GUEST_POOL_SIZE (default 20) guest traders signed up through the real sign-up on test
//      numbers +234 700 000 0601.., then each place asked for a reset; scheduler/guests runs the
//      resets (database at once, Stellar a step at a time) until every place is ready.
// reset: ask for a reset of one place, every trader, or the agents, then drive scheduler/guests.
// status: every place (idle or in use, last used, reset step, balance) and the treasury.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Asset, BASE_FEE, Horizon, Keypair, Operation, rpc, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { OutcomeUnknownError, submitTransaction } from "../supabase/functions/_shared/stellar-retry.ts";
import { signUp, testNin, testPin } from "./lib/onboard.ts";
import { adminClient, loadLocalEnv, ROOT } from "./lib/supabase-admin.ts";

loadLocalEnv();
const cmd = process.argv[2];
const arg = process.argv[3];
const PASSPHRASE = "Test SDF Network ; September 2015";
const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-rpc.testnet.stellar.gateway.fm";
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
const server = new rpc.Server(RPC_URL);
const STATE_FILE = join(ROOT, "scripts", ".guests-state.json");
const UNIT = 10_000_000n;
const POOL = Math.max(1, Math.min(30, Number(process.env.GUEST_POOL_SIZE ?? 20) || 20));
export const TREASURY_TARGET = 50_000_000n; // naira the issuer keeps in the guests' treasury
const { db, url } = adminClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The same lists as supabase/functions/_shared/guests.ts (that file is Deno; these are plain data).
const NAMES = [
  "Adaeze", "Bola", "Chiamaka", "Hauwa", "Ngozi", "Yetunde", "Amina", "Folake", "Ifeoma", "Zainab",
  "Kehinde", "Blessing", "Titi", "Nneka", "Halima", "Sade", "Ebere", "Rukayat", "Uche", "Mojisola",
  "Aisha", "Funke", "Jumoke", "Lami", "Omolara", "Patience", "Remi", "Shade", "Temitope", "Yemisi",
];
const guestPhone = (slot: number) => `+2347000000${600 + slot}`;
const MEMBERS = [
  { signer: "ajo_m1", name: "Iya Sade", phone: "+2347000000691" },
  { signer: "ajo_m2", name: "Baba Femi", phone: "+2347000000692" },
  { signer: "ajo_m3", name: "Mama Ifeoma", phone: "+2347000000693" },
];
const SHOP = { signer: "guest_shop", name: "Mama Put Canteen", phone: "+2347000000690" };
const AGENTS = [
  { slot: 0, name: "Mama Bisi", phone: "+2347000000680" }, // the shared demo agent behind every guest's pretend cash
  { slot: 1, name: "Agent Chinedu", phone: "+2347000000681" },
  { slot: 2, name: "Agent Halima", phone: "+2347000000682" },
  { slot: 3, name: "Agent Musa", phone: "+2347000000683" },
];
const SIGNERS = ["guest_treasury", SHOP.signer, ...MEMBERS.map((m) => m.signer), ...AGENTS.map((a) => `guest_agent${a.slot}`)];

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
const cliEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("STELLAR_")));
const stellar = (args: string[]) => execFileSync("stellar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: cliEnv }).trim();

async function call(path: string, body: unknown = {}): Promise<Record<string, unknown>> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${url}/functions/v1/${path}`, {
        method: "POST",
        headers: { "x-plus-secret": process.env.AGENT_SHARED_SECRET!, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      return JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      if (i >= 4) throw e;
      await sleep(3000 * (i + 1)); // a cold start or a gateway hiccup: try again
    }
  }
}

async function ngnt(pub: string, issuer: string): Promise<bigint | null> {
  try {
    const a = await horizon.loadAccount(pub);
    const line = a.balances.find((b) => "asset_code" in b && b.asset_code === "NGNT" && b.asset_issuer === issuer);
    return line ? toUnits(line.balance) : null;
  } catch {
    return null;
  }
}

// --- the one issuer payment, journalled ------------------------------------------------------
type Entry = { label: string; hash: string; xdr: string; maxTime: number; status: "pending" | "done" | "dropped" };
const journal: Entry[] = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : [];
const saveJournal = () => writeFileSync(STATE_FILE, JSON.stringify(journal.slice(-50), null, 2) + "\n");

async function settleJournal(): Promise<boolean> {
  let busy = false;
  for (const e of journal.filter((x) => x.status === "pending")) {
    const res = await server.getTransaction(e.hash);
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) e.status = "done";
    else if (res.status === rpc.Api.GetTransactionStatus.FAILED || Date.now() / 1000 > e.maxTime + 10) e.status = "dropped";
    else busy = true;
    console.log(`  earlier run: ${e.label} ${e.status === "pending" ? "still pending" : e.status}`);
  }
  saveJournal();
  return busy;
}

async function issuerPays(label: string, to: string, units: bigint, NGNT: Asset) {
  const issuer = Keypair.fromSecret(stellar(["keys", "secret", "issuer"]));
  const tx = new TransactionBuilder(await horizon.loadAccount(issuer.publicKey()), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.payment({ destination: to, asset: NGNT, amount: decimal(units) })).setTimeout(60).build();
  tx.sign(issuer);
  const e: Entry = { label, hash: tx.hash().toString("hex"), xdr: tx.toXDR(), maxTime: Number(tx.timeBounds?.maxTime ?? 0), status: "pending" };
  journal.push(e);
  saveJournal(); // the hash is on disk before the network sees it
  try {
    const res = await submitTransaction(server, tx as Transaction, { attempts: 3, baseDelayMs: 1000 });
    if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`${label}: failed on-chain`);
  } catch (err) {
    if (err instanceof OutcomeUnknownError) throw new Error(`${label}: ${e.hash} not found yet; run again to look it up`);
    throw err;
  }
  e.status = "done";
  saveJournal();
  console.log(`  ✓ ${label}  https://stellar.expert/explorer/testnet/tx/${e.hash}`);
}

// --- seed ------------------------------------------------------------------------------------
async function provision(signer: string): Promise<string> {
  let a = await call("scheduler/provision", { signer });
  for (let i = 0; i < 30 && a.ok && a.status !== "done"; i++) {
    await sleep(2000);
    a = await call("scheduler/provision", { signer });
  }
  if (!a.ok || a.status !== "done") throw new Error(`${signer}: wallet not ready (${a.error ?? a.status}); run again`);
  return String(a.pub);
}

async function upsertUser(row: { name: string; phone: string; signer: string; pub: string; weeks: number; payCode?: boolean }) {
  const existing = must(await db.from("users").select("id, pay_code").eq("wa_phone", row.phone).is("archived_at", null).maybeSingle(), row.name) as { id: string; pay_code: string | null } | null;
  const fields = {
    market_id: "ng", wa_phone: row.phone, name: row.name, language: "en", kyc_tier: 2, stellar_pub: row.pub,
    secret_name: `STELLAR_SECRET_${row.signer.toUpperCase()}`, member_since: new Date(Date.now() - row.weeks * 7 * 86_400_000).toISOString(),
    onboarded_via: "app",
  };
  if (existing) {
    must(await db.from("users").update(fields).eq("id", existing.id), row.name);
    if (row.payCode && !existing.pay_code) must(await db.from("users").update({ pay_code: payCode() }).eq("id", existing.id), "pay code");
    return existing.id;
  }
  const r = must(await db.from("users").insert({ ...fields, ...(row.payCode ? { pay_code: payCode() } : {}) }).select("id").single(), row.name) as { id: string };
  return r.id;
}
function payCode() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(6), (b) => A[b % A.length]).join("");
}

async function upsertAgent(a: { slot: number; name: string; phone: string }, pub: string) {
  const existing = must(await db.from("helpers").select("id, auth_user_id").eq("guest_slot", a.slot).maybeSingle(), a.name) as { id: string; auth_user_id: string | null } | null;
  let authId = existing?.auth_user_id ?? null;
  if (!authId && a.slot > 0) {
    const email = `guest-agent-${a.slot}@example.com`;
    const created = await db.auth.admin.createUser({
      email, email_confirm: true, password: randomBytes(24).toString("base64url"), app_metadata: { plus_role: "helper", guest: true },
    });
    if (created.error) {
      // Made on an earlier run: find it.
      const list = must(await db.auth.admin.listUsers({ perPage: 1000 }), "users") as { users: { id: string; email?: string }[] };
      authId = list.users.find((u) => u.email === email)?.id ?? null;
      if (!authId) throw new Error(`${email}: ${created.error.message}`);
    } else authId = created.data.user!.id;
  }
  const fields = {
    market_id: "ng", name: a.name, phone: a.phone, role: "agent", daily_limit: 50_000_000, active: true, stellar_pub: pub,
    secret_name: `STELLAR_SECRET_GUEST_AGENT${a.slot}`, auth_user_id: authId, demo_login: false, guest_slot: a.slot,
  };
  const id = existing
    ? (must(await db.from("helpers").update(fields).eq("id", existing.id).select("id").single(), a.name) as { id: string }).id
    : (must(await db.from("helpers").insert(fields).select("id").single(), a.name) as { id: string }).id;
  must(await db.from("guest_pool").upsert({ kind: "agent", slot: a.slot, helper_id: id }, { onConflict: "kind,slot", ignoreDuplicates: true }), "agent place");
  return id;
}

async function seedTrader(slot: number) {
  const have = must(await db.from("guest_pool").select("user_id").eq("kind", "trader").eq("slot", slot).maybeSingle(), "place") as { user_id: string } | null;
  if (have?.user_id) return false;
  const phone = guestPhone(slot);
  let u = must(await db.from("users").select("id, stellar_pub").eq("wa_phone", phone).is("archived_at", null).maybeSingle(), "guest") as { id: string; stellar_pub: string | null } | null;
  if (!u?.stellar_pub) {
    console.log(`  ${NAMES[slot - 1]} (${phone}): the real sign-up`);
    await signUp(url, process.env.VITE_SUPABASE_ANON_KEY!, { name: NAMES[slot - 1], language: "en", phone, pin: testPin(), nin: testNin() });
    u = must(await db.from("users").select("id, stellar_pub").eq("wa_phone", phone).is("archived_at", null).single(), "guest") as { id: string; stellar_pub: string };
  }
  must(await db.from("users").update({ guest_slot: slot, demo_login: false }).eq("id", u.id), "guest slot");
  must(await db.from("guest_pool").upsert({ kind: "trader", slot, user_id: u.id, reset_requested_at: new Date().toISOString() }, { onConflict: "kind,slot" }), "place");
  return true;
}

async function seed() {
  console.log(`Guests: seeding a pool of ${POOL} · testnet · ${url}`);
  if (await settleJournal()) throw new Error("an earlier issuer payment is still pending; run again in a minute");
  const NGNT = new Asset("NGNT", stellar(["keys", "address", "issuer"]));
  console.log("1. System wallets (keys in Vault)");
  const pubs: Record<string, string> = {};
  for (const s of SIGNERS) {
    pubs[s] = await provision(s);
    console.log(`  ✓ ${s.padEnd(15)} ${pubs[s]}`);
  }
  must(await db.from("system_wallets").upsert({ signer: "iya_tunde", pub: stellar(["keys", "address", "iya_tunde"]) }), "iya_tunde");

  console.log("2. Treasury");
  const have = await ngnt(pubs.guest_treasury, NGNT.getIssuer()) ?? 0n;
  if (have < TREASURY_TARGET * UNIT / 2n) await issuerPays(`issuer funds the guests' treasury to ${naira(TREASURY_TARGET * UNIT)}`, pubs.guest_treasury, TREASURY_TARGET * UNIT - have, NGNT);
  else console.log(`  treasury holds ${naira(have)}`);

  console.log("3. Shop, ajo members, agents");
  await upsertUser({ ...SHOP, pub: pubs[SHOP.signer], weeks: 60, payCode: true });
  for (const m of MEMBERS) await upsertUser({ ...m, pub: pubs[m.signer], weeks: 30 });
  for (const a of AGENTS) await upsertAgent(a, pubs[`guest_agent${a.slot}`]);
  must(await db.from("guest_pool").update({ reset_requested_at: new Date().toISOString() }).eq("kind", "agent").is("reset_done_at", null), "agents reset");
  const shop = must(await db.from("users").select("pay_code").eq("wa_phone", SHOP.phone).single(), "shop") as { pay_code: string };
  console.log(`  ✓ ${SHOP.name} pay code ${shop.pay_code.slice(0, 3)}-${shop.pay_code.slice(3)}; ${MEMBERS.map((m) => m.name).join(", ")}; ${AGENTS.map((a) => a.name).join(", ")}`);

  // The shared demo agent pays part of every guest's history: its float first.
  for (let i = 0; i < 20; i++) {
    const p = must(await db.from("guest_pool").select("*").eq("kind", "agent").eq("slot", 0).single(), "agent 0") as Place;
    if (ready(p)) break;
    console.log(`  shared demo agent: ${p.reset_step ?? "requested"}`);
    await call("scheduler/guests", { wait: true });
  }
  console.log(`4. ${POOL} guest traders`);
  for (let slot = 1; slot <= POOL; slot++) {
    if (await seedTrader(slot)) console.log(`  ✓ place ${slot}: ${NAMES[slot - 1]}`);
  }
  await drive();
}

// --- reset / drive ---------------------------------------------------------------------------
type Place = { kind: string; slot: number; user_id: string | null; helper_id: string | null; last_seen_at: string | null; used: boolean; device_hash: string | null;
  reset_requested_at: string | null; reset_started_at: string | null; reset_done_at: string | null; reset_step: string | null; reset_error: string | null };
const ready = (p: Place) => Boolean(p.reset_done_at) && (!p.reset_started_at || p.reset_done_at! >= p.reset_started_at) && !p.reset_requested_at;

async function drive(limitMs = 20 * 60_000) {
  console.log("5. Resets (scheduler/guests: the database at once, Stellar a step at a time)");
  const t0 = Date.now();
  for (;;) {
    const r = await call("scheduler/guests", { wait: true }) as { steps?: Record<string, string>; started?: string[]; error?: string };
    if (r.error) console.log(`  ! ${r.error}`);
    const places = must(await db.from("guest_pool").select("*").order("kind").order("slot"), "pool") as Place[];
    const left = places.filter((p) => !ready(p));
    const errs = places.filter((p) => p.reset_error);
    console.log(`  ${Math.round((Date.now() - t0) / 1000)} s: ${places.length - left.length}/${places.length} ready${errs.length ? `, ${errs.length} with errors` : ""}${left.length ? ` · e.g. ${left.slice(0, 3).map((p) => `${p.kind} ${p.slot} ${p.reset_step ?? "waiting"}`).join(", ")}` : ""}`);
    if (!left.length) break;
    if (Date.now() - t0 > limitMs) {
      console.log("  still going: the scheduler carries on every minute (pnpm guests:status to look)");
      break;
    }
  }
  await status();
}

async function reset() {
  const iso = new Date().toISOString();
  let q = db.from("guest_pool").update({ reset_requested_at: iso, last_seen_at: null });
  if (arg === "agents") q = q.eq("kind", "agent");
  else if (arg && arg !== "all") q = q.eq("kind", "trader").eq("slot", Number(arg));
  else q = q.eq("kind", "trader");
  must(await q, "request");
  console.log(`Guests: reset ${arg ?? "all"} requested`);
  await drive();
}

// --- status ----------------------------------------------------------------------------------
export async function status() {
  const issuer = stellar(["keys", "address", "issuer"]);
  const places = must(await db.from("guest_pool").select("*").order("kind").order("slot"), "pool") as Place[];
  const ids = places.map((p) => p.user_id).filter(Boolean) as string[];
  const users = ids.length ? must(await db.from("users").select("id, name, stellar_pub").in("id", ids), "users") as { id: string; name: string; stellar_pub: string }[] : [];
  const hids = places.map((p) => p.helper_id).filter(Boolean) as string[];
  const helpers = hids.length ? must(await db.from("helpers").select("id, name, stellar_pub").in("id", hids), "helpers") as { id: string; name: string; stellar_pub: string }[] : [];
  const ago = (iso: string | null) => (iso ? `${Math.round((Date.now() - Date.parse(iso)) / 60_000)} min ago` : "never");
  console.log("\nPlace        Name            State      Last used        Wallet        Reset");
  for (const p of places) {
    const who = p.kind === "trader" ? users.find((u) => u.id === p.user_id) : helpers.find((h) => h.id === p.helper_id);
    const idle = !p.last_seen_at || Date.now() - Date.parse(p.last_seen_at) >= 30 * 60_000;
    const bal = who?.stellar_pub ? await ngnt(who.stellar_pub, issuer) : null;
    console.log(`${`${p.kind} ${p.slot}`.padEnd(12)} ${(who?.name ?? "?").padEnd(15)} ${(p.slot === 0 ? "shared" : idle ? "idle" : "in use").padEnd(10)} ${ago(p.last_seen_at).padEnd(16)} ${(bal === null ? "-" : naira(bal)).padEnd(13)} ${ready(p) ? "ready" : (p.reset_step ?? "requested")}${p.reset_error ? ` (${p.reset_error.slice(0, 60)})` : ""}`);
  }
  const { data: tw } = await db.from("system_wallets").select("pub").eq("signer", "guest_treasury").maybeSingle();
  if (tw?.pub) console.log(`\nTreasury ${tw.pub.slice(0, 6)}… holds ${naira(await ngnt(tw.pub, issuer) ?? 0n)}`);
  return places;
}

async function main() {
  if ((process.env.STELLAR_NETWORK ?? "testnet") !== "testnet") throw new Error("testnet only");
  if (cmd === "seed") await seed();
  else if (cmd === "reset") await reset();
  else if (cmd === "status") await status();
  else {
    console.error("usage: node scripts/guests.ts seed | reset [slot|all|agents] | status");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(`\nguests ${cmd} failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
