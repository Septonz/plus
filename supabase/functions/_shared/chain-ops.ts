// What each chain_outbox row turns into on Stellar. Pure (no network), so it is unit-tested.
//   attest, group_record, contract            -> one Soroban contract call, sent through RPC
//   payment, claimable_create, claimable_claim -> one classic operation, sent through Horizon
//   create_wallet                              -> a partner-sponsored account with trustlines (Horizon)
import { Buffer } from "node:buffer";
import { StellarSdk } from "./stellar.ts";

const { Contract, Operation, Asset, Claimant, nativeToScVal, Address, xdr } = StellarSdk;

export type OutboxKind = "attest" | "group_record" | "contract" | "payment" | "claimable_create" | "claimable_claim" | "create_wallet";
export type OutboxRow = {
  id: number;
  kind: OutboxKind;
  signer: string;
  args: Record<string, unknown>;
  ref: string;
  status: string;
  attempts: number;
  tx_hash: string | null;
  tx_valid_until: string | null;
  after_id: number | null;
  result: Record<string, unknown> | null;
};

export const CLASSIC_KINDS = new Set<OutboxKind>(["payment", "claimable_create", "claimable_claim", "create_wallet"]);
export const railOf = (kind: OutboxKind): "horizon" | "rpc" => (CLASSIC_KINDS.has(kind) ? "horizon" : "rpc");

/** Testnet assets by code. Issuers are public (docs/deployments.md); override with env if redeployed. */
export const ASSET_ISSUERS: Record<string, string> = {
  NGNT: "GDLLQ6TC6GJBOOWCTBTMDMFWRKUHKW7UOWZMIA6WZNCZJHTC3UBS3SVB",
  USDC: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};

export function assetOf(code: unknown): InstanceType<typeof Asset> {
  if (code === "XLM" || code === "native") return Asset.native();
  const issuer = ASSET_ISSUERS[String(code)];
  if (!issuer) throw new Error(`unknown asset ${String(code)}`);
  return new Asset(String(code), issuer);
}

/** Stroops (integer string, 7 decimals) to the decimal string classic operations take. Never floats. */
export function stroopsToAmount(stroops: unknown): string {
  const s = String(stroops);
  if (!/^[0-9]+$/.test(s) || BigInt(s) <= 0n) throw new Error(`bad amount ${s}`);
  const v = BigInt(s);
  const whole = v / 10_000_000n;
  const frac = (v % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const G = /^G[A-Z2-7]{55}$/;
const account = (v: unknown, what: string) => {
  if (typeof v !== "string" || !G.test(v)) throw new Error(`bad ${what} address`);
  return v;
};

// --- Soroban values -------------------------------------------------------------------------

export type ContractArg =
  | { t: "address"; v: string }
  | { t: "i128"; v: string }
  | { t: "u32"; v: number }
  | { t: "u64"; v: string }
  | { t: "bytes32"; v: string }
  | { t: "opt_bytes32"; v: string | null }
  | { t: "bool"; v: boolean };

export function scVal(a: ContractArg) {
  switch (a.t) {
    case "address":
      return new Address(a.v).toScVal();
    case "i128":
      if (!/^-?[0-9]+$/.test(String(a.v))) throw new Error("bad i128");
      return nativeToScVal(BigInt(a.v), { type: "i128" });
    case "u32":
      if (!Number.isInteger(a.v) || a.v < 0) throw new Error("bad u32");
      return nativeToScVal(a.v, { type: "u32" });
    case "u64":
      return nativeToScVal(BigInt(a.v), { type: "u64" });
    case "bytes32":
      if (!/^[0-9a-f]{64}$/.test(a.v)) throw new Error("bad 32-byte hex");
      return xdr.ScVal.scvBytes(Buffer.from(a.v, "hex"));
    case "opt_bytes32":
      if (a.v === null || a.v === undefined) return xdr.ScVal.scvVoid();
      if (!/^[0-9a-f]{64}$/.test(a.v)) throw new Error("bad 32-byte hex");
      return xdr.ScVal.scvBytes(Buffer.from(a.v, "hex"));
    case "bool":
      return xdr.ScVal.scvBool(Boolean(a.v));
  }
  throw new Error(`bad contract arg type ${String((a as { t?: unknown }).t)}`);
}

const ATTEST_KIND: Record<string, number> = { received: 0, saved: 1, paid: 2 };

/**
 * A new user's wallet, in one transaction from partner: partner sponsors every reserve (the account
 * and its trustlines), so she never needs XLM; the account then trusts NGNT and USDC. Partner signs
 * as source and sponsor, the new account signs its own trustlines and the end of the sponsorship.
 */
export function createWalletOps(args: Record<string, unknown>, sponsor: string) {
  const pub = account(args.pub, "new wallet");
  const lines = (Array.isArray(args.trustlines) ? args.trustlines : ["NGNT", "USDC"]).map(String);
  if (lines.length === 0 || lines.length > 4) throw new Error("bad trustlines");
  return [
    Operation.beginSponsoringFutureReserves({ sponsoredId: pub, source: account(sponsor, "sponsor") }),
    Operation.createAccount({ destination: pub, startingBalance: "0" }),
    ...lines.map((code) => Operation.changeTrust({ asset: assetOf(code), source: pub })),
    Operation.endSponsoringFutureReserves({ source: pub }),
  ];
}

/**
 * The contracts a "contract" row can call: `plus` (the default) or `credit` (plus_credit, piece 8:
 * loans, assets and vouches, written by partner).
 */
export type ContractIds = { plus: string; credit?: string };

/** The single operation for a row. Contract calls need the contract id(s). */
export function operationFor(row: Pick<OutboxRow, "kind" | "args">, ids: string | ContractIds) {
  const { plus: contractId, credit: creditId } = typeof ids === "string" ? { plus: ids, credit: undefined } : ids;
  const a = row.args;
  switch (row.kind) {
    case "attest": {
      const kind = ATTEST_KIND[String(a.kind)];
      if (kind === undefined) throw new Error(`unknown attest kind ${String(a.kind)}`);
      return new Contract(contractId).call("attest", scVal({ t: "bytes32", v: String(a.user_ref) }), scVal({ t: "u32", v: kind }),
        scVal({ t: "i128", v: String(a.amount) }), scVal({ t: "bytes32", v: String(a.payment_ref) }));
    }
    case "group_record":
      return new Contract(contractId).call("group_record", scVal({ t: "u32", v: Number(a.group_id) }),
        scVal({ t: "bytes32", v: String(a.member_ref) }), scVal({ t: "i128", v: String(a.amount) }),
        scVal({ t: "bytes32", v: String(a.payment_ref) }));
    case "contract": {
      if (typeof a.fn !== "string" || !/^[a-z_][a-z0-9_]{0,31}$/.test(a.fn)) throw new Error("bad contract fn");
      const args = (Array.isArray(a.args) ? a.args : []) as ContractArg[];
      const target = a.contract === undefined || a.contract === "plus" ? contractId : a.contract === "credit" ? creditId : null;
      if (!target) throw new Error(a.contract === "credit" ? "PLUS_CREDIT_CONTRACT_ID is not set" : `unknown contract ${String(a.contract)}`);
      return new Contract(target).call(a.fn, ...args.map(scVal));
    }
    case "payment":
      return Operation.payment({ destination: account(a.to, "destination"), asset: assetOf(a.asset), amount: stroopsToAmount(a.amount) });
    case "claimable_create": {
      // Claimable by each listed claimant (e.g. registered agents) at any time, and by the owner
      // (returns) only after `return_after_secs`, so an unredeemed cash-out comes back to her.
      const claimants = (Array.isArray(a.claimants) ? a.claimants : []).map((c) => new Claimant(account(c, "claimant"), Claimant.predicateUnconditional()));
      if (a.owner) {
        const after = Number(a.return_after_secs ?? 7 * 86_400);
        claimants.push(new Claimant(account(a.owner, "owner"), Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(String(after)))));
      }
      if (claimants.length === 0 || claimants.length > 10) throw new Error("bad claimants");
      return Operation.createClaimableBalance({ asset: assetOf(a.asset), amount: stroopsToAmount(a.amount), claimants });
    }
    case "create_wallet":
      throw new Error("create_wallet has several operations: use createWalletOps");
    case "claimable_claim":
      if (typeof a.balance_id !== "string" || !/^[0-9a-f]{72}$/.test(a.balance_id)) throw new Error("bad balance id");
      return Operation.claimClaimableBalance({ balanceId: a.balance_id });
  }
  throw new Error(`unknown kind ${String(row.kind)}`);
}
