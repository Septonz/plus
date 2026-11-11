// Nigeria: reads from Stellar. Balances come from Horizon (the user's own account); contract state
// (ajo group, advance, credit limit) from RPC simulation of the contract's view functions. Nothing
// here signs or sends anything.
import type { SupabaseClient } from "@supabase/supabase-js";
import { ASSET_ISSUERS } from "./chain-ops.ts";
import type { ChainAdvance, ChainGroup, ContractReader } from "./ng-types.ts";

export type { ChainAdvance, ChainGroup, ContractReader };

export const HORIZON_URL = Deno.env.get("STELLAR_HORIZON_URL") || "https://horizon-testnet.stellar.org";
const RPC_URL = Deno.env.get("STELLAR_RPC_URL") || "https://soroban-testnet.stellar.org";
const PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") || "Test SDF Network ; September 2015";

export type WalletAsset = "NGNT" | "USDC" | "XLM";

/** "26400.1234567" -> 2640012 (minor units: kobo or cents; extra decimals are cut, never rounded up). */
export function decimalToMinor(value: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`bad amount ${value}`);
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
}

/** On-chain i128 (7 decimals) -> minor units (2 decimals). */
export const chainToMinor = (v: unknown) => BigInt(String(v ?? "0")) / 100000n;

type HorizonBalance = { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string };

/** One Horizon read of an account's balances, in minor units, with how long it took. */
export async function horizonBalances(pub: string): Promise<{ balances: Partial<Record<WalletAsset, bigint>>; ms: number; exists: boolean }> {
  const t0 = performance.now();
  const res = await fetch(`${HORIZON_URL}/accounts/${pub}`);
  const ms = Math.round(performance.now() - t0);
  if (res.status === 404) {
    await res.body?.cancel();
    return { balances: {}, ms, exists: false };
  }
  if (!res.ok) throw new Error(`horizon ${res.status}`);
  const acct = await res.json() as { balances: HorizonBalance[] };
  const out: Partial<Record<WalletAsset, bigint>> = {};
  for (const b of acct.balances) {
    if (b.asset_type === "native") out.XLM = decimalToMinor(b.balance);
    else if (b.asset_code === "NGNT" && b.asset_issuer === ASSET_ISSUERS.NGNT) out.NGNT = decimalToMinor(b.balance);
    else if (b.asset_code === "USDC" && b.asset_issuer === ASSET_ISSUERS.USDC) out.USDC = decimalToMinor(b.balance);
  }
  return { balances: out, ms, exists: true };
}

/** Refresh wallet_balances for these users from Horizon. Returns the Horizon read times (ms). */
export async function refreshBalances(db: SupabaseClient, userIds: string[]): Promise<number[]> {
  if (userIds.length === 0) return [];
  const { data, error } = await db.from("users").select("id, stellar_pub").in("id", [...new Set(userIds)]).not("stellar_pub", "is", null);
  if (error) throw new Error(`refreshBalances users: ${error.message}`);
  const times: number[] = [];
  await Promise.all((data ?? []).map(async (u) => {
    const r = await horizonBalances(u.stellar_pub as string);
    times.push(r.ms);
    if (!r.exists) return;
    const now = new Date().toISOString();
    const rows = (Object.entries(r.balances) as [WalletAsset, bigint][])
      .map(([asset, amount]) => ({ user_id: u.id, asset, amount: amount.toString(), horizon_ms: r.ms, updated_at: now }));
    if (rows.length === 0) return;
    const { error: upErr } = await db.from("wallet_balances").upsert(rows, { onConflict: "user_id,asset" });
    if (upErr) throw new Error(`refreshBalances upsert: ${upErr.message}`);
  }));
  return times;
}

// ---------------------------------------------------------------------------
// Contract views (simulation only: a random source account, never signed or sent)
// ---------------------------------------------------------------------------

export function contractReader(contractId: string): ContractReader {
  // Loaded on first use: the SDK import is the slow part of a cold start.
  const sdk = import("./stellar.ts").then((m) => m.StellarSdk);

  async function view(fn: string, args: (s: Awaited<typeof sdk>) => unknown[]): Promise<unknown> {
    const S = await sdk;
    const { rpc, Contract, TransactionBuilder, Account, Keypair, scValToNative } = S;
    const server = new rpc.Server(RPC_URL);
    const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), { fee: "100", networkPassphrase: PASSPHRASE })
      .addOperation(new Contract(contractId).call(fn, ...(args(S) as never[])))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(`${fn}: simulation failed`);
    return sim.result ? scValToNative(sim.result.retval) : null;
  }
  const account = (S: Awaited<typeof sdk>, pub: string) =>
    S.xdr.ScVal.scvVec([S.xdr.ScVal.scvSymbol("Account"), new S.Address(pub).toScVal()]);

  return {
    async group(id) {
      let g: Record<string, unknown> | null;
      try {
        g = await view("group", (S) => [S.nativeToScVal(id, { type: "u32" })]) as Record<string, unknown> | null;
      } catch {
        return null;
      }
      if (!g) return null;
      return {
        members: (g.members as unknown[]).map((m) => (Array.isArray(m) && m[0] === "Account" ? String(m[1]) : "")),
        amount_minor: chainToMinor(g.amount),
        period_secs: Number(g.period_secs),
        next_due: new Date(Number(g.next_due) * 1000),
        turn: Number(g.turn),
        pot_minor: chainToMinor(g.pot),
        pooled: Boolean(g.pooled),
        contributed: (g.contributed as boolean[]).map(Boolean),
      };
    },
    async advanceOf(pub) {
      const a = await view("advance_of", (S) => [account(S, pub)]) as Record<string, unknown> | null | undefined;
      if (!a) return null;
      return {
        principal_minor: chainToMinor(a.principal),
        fee_minor: chainToMinor(a.fee),
        owed_minor: chainToMinor(a.owed),
        opened_at: new Date(Number(a.opened_ts) * 1000),
      };
    },
    async limitOf(pub) {
      return chainToMinor(await view("limit_of", (S) => [account(S, pub)]));
    },
    async poolBalance(assetSac) {
      return chainToMinor(await view("pool_balance", (S) => [new S.Address(assetSac).toScVal()]));
    },
    async pot(id) {
      let p: Record<string, unknown> | null;
      try {
        p = await view("pot", (S) => [S.nativeToScVal(id, { type: "u32" })]) as Record<string, unknown> | null;
      } catch {
        return null;
      }
      if (!p) return null;
      return {
        sender: String(p.sender),
        payout_to: String(p.payout_to),
        balance_minor: chainToMinor(p.balance),
        per_period_minor: chainToMinor(p.per_period),
        period_secs: Number(p.period_secs),
      };
    },
  };
}
