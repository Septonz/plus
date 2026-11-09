import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CAM3QTVSTGHWDZKHVUW7AI5NLNB5PRTP44UP5QN3V3WLZK7UAKLEP6RI",
  }
} as const


export interface Pot {
  asset: string;
  balance: i128;
  next_release: u64;
  payout_to: string;
  per_period: i128;
  /**
 * 0 means manual release only.
 */
period_secs: u64;
  sender: string;
}

export const Errors = {
  1: {message:"NotAuthorized"},
  2: {message:"Paused"},
  3: {message:"InvalidAmount"},
  4: {message:"AssetNotAllowed"},
  5: {message:"NotFound"},
  6: {message:"NotMember"},
  7: {message:"WrongMode"},
  8: {message:"AlreadyContributed"},
  9: {message:"NotDue"},
  10: {message:"OverLimit"},
  11: {message:"AdvanceOpen"},
  12: {message:"NoAdvance"},
  13: {message:"InsufficientPool"},
  14: {message:"InsufficientBalance"},
  15: {message:"DuplicateMember"}
}


export interface Group {
  amount: i128;
  asset: string;
  contributed: Array<boolean>;
  members: Array<Party>;
  next_due: u64;
  organizer: string;
  period_secs: u64;
  pooled: boolean;
  pot: i128;
  turn: u32;
}

/**
 * A participant: either a Stellar account or a 32-byte off-chain reference hash.
 */
export type Party = {tag: "Account", values: readonly [string]} | {tag: "Ref", values: readonly [Buffer]};


/**
 * Public view of the configuration. `admin` is read from OpenZeppelin access control.
 */
export interface Config {
  admin: string;
  advance_fee_bps: u32;
  assets: Array<string>;
  partner: string;
}



export interface Advance {
  /**
 * Set only for `Party::Account` advances paid out of the on-chain pool.
 */
asset: Option<string>;
  fee: i128;
  opened_ts: u64;
  owed: i128;
  principal: i128;
}





export enum AttestKind {
  Received = 0,
  Saved = 1,
  Paid = 2,
}









export interface RecordSummary {
  count: u32;
  first_ts: u64;
  last_ts: u64;
  total_group: i128;
  total_paid: i128;
  total_received: i128;
  total_saved: i128;
}





export const RoleTransferError = {
  2200: {message:"NoPendingTransfer"},
  2201: {message:"InvalidLiveUntilLedger"},
  2202: {message:"InvalidPendingAccount"},
  2203: {message:"TransferExpired"}
}





export const AccessControlError = {
  2000: {message:"Unauthorized"},
  2001: {message:"AdminNotSet"},
  2002: {message:"IndexOutOfBounds"},
  2003: {message:"AdminRoleNotFound"},
  2004: {message:"RoleCountIsNotZero"},
  2005: {message:"RoleNotFound"},
  2006: {message:"AdminAlreadySet"},
  2007: {message:"RoleNotHeld"},
  2008: {message:"RoleIsEmpty"},
  2009: {message:"TransferInProgress"},
  2010: {message:"MaxRolesExceeded"}
}





export const PausableError = {
  /**
   * The operation failed because the contract is paused.
   */
  1000: {message:"EnforcedPause"},
  /**
   * The operation failed because the contract is not paused.
   */
  1001: {message:"ExpectedPause"}
}

export interface Client {
  /**
   * Construct and simulate a pot transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pot: ({pot_id}: {pot_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Pot>>>

  /**
   * Construct and simulate a group transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  group: ({group_id}: {group_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Group>>>

  /**
   * Construct and simulate a pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pause: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a repay transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  repay: ({user, amount}: {user: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a attest transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  attest: ({user_ref, kind, amount, payment_ref}: {user_ref: Buffer, kind: AttestKind, amount: i128, payment_ref: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  config: (options?: MethodOptions) => Promise<AssembledTransaction<Config>>

  /**
   * Construct and simulate a paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  paused: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a unpause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  unpause: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a has_role transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns `Some(index)` if the account has the specified role,
   * where `index` is the position of the account for that role,
   * and can be used to query [`AccessControl::get_role_member()`].
   * Returns `None` if the account does not have the specified role.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * * `account` - The account to check.
   * * `role` - The role to check for.
   */
  has_role: ({account, role}: {account: string, role: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<u32>>>

  /**
   * Construct and simulate a limit_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  limit_of: ({party}: {party: Party}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a pot_fund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pot_fund: ({sender, pot_id, amount}: {sender: string, pot_id: u32, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a pot_send transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pot_send: ({sender, pot_id, amount}: {sender: string, pot_id: u32, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a add_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  add_asset: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a fund_pool transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  fund_pool: ({asset, amount}: {asset: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the admin account.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a record_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  record_of: ({user_ref}: {user_ref: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<RecordSummary>>

  /**
   * Construct and simulate a advance_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  advance_of: ({party}: {party: Party}, options?: MethodOptions) => Promise<AssembledTransaction<Option<Advance>>>

  /**
   * Construct and simulate a grant_role transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Grants a role to an account.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * * `account` - The account to grant the role to.
   * * `role` - The role to grant.
   * * `caller` - The address of the caller, must be the admin or have the
   * `RoleAdmin` for the `role`.
   * 
   * # Errors
   * 
   * * [`AccessControlError::Unauthorized`] - If the caller does not have
   * enough privileges.
   * * [`AccessControlError::MaxRolesExceeded`] - If adding a new role would
   * exceed the maximum allowed number of roles.
   * 
   * # Events
   * 
   * * topics - `["role_granted", role: Symbol, account: Address]`
   * * data - `[caller: Address]`
   */
  grant_role: ({account, role, caller}: {account: string, role: string, caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a pot_cancel transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pot_cancel: ({sender, pot_id}: {sender: string, pot_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a pot_create transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pot_create: ({sender, payout_to, asset, per_period, period_secs}: {sender: string, payout_to: string, asset: string, per_period: i128, period_secs: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a pot_release transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pot_release: ({pot_id}: {pot_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a revoke_role transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Revokes a role from an account.
   * To revoke the caller's own role, use
   * [`AccessControl::renounce_role()`] instead.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * * `account` - The account to revoke the role from.
   * * `role` - The role to revoke.
   * * `caller` - The address of the caller, must be the admin or has the
   * `RoleAdmin` for the `role`.
   * 
   * # Errors
   * 
   * * [`AccessControlError::Unauthorized`] - If the `caller` does not have
   * enough privileges.
   * * [`AccessControlError::RoleNotHeld`] - If the `account` doesn't have
   * the role.
   * * [`AccessControlError::RoleIsEmpty`] - If the role has no members.
   * 
   * # Events
   * 
   * * topics - `["role_revoked", role: Symbol, account: Address]`
   * * data - `[caller: Address]`
   */
  revoke_role: ({account, role, caller}: {account: string, role: string, caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a group_create transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  group_create: ({organizer, members, asset, amount, period_secs, pooled}: {organizer: string, members: Array<Party>, asset: string, amount: i128, period_secs: u64, pooled: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a group_payout transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  group_payout: ({group_id}: {group_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a group_record transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  group_record: ({group_id, member_ref, amount, payment_ref}: {group_id: u32, member_ref: Buffer, amount: i128, payment_ref: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a pool_balance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  pool_balance: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a renounce_role transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Allows an account to renounce a role assigned to itself.
   * Users can only renounce roles for their own account.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * * `role` - The role to renounce.
   * * `caller` - The address of the caller, must be the account that has the
   * role.
   * 
   * # Errors
   * 
   * * [`AccessControlError::RoleNotHeld`] - If the `caller` doesn't have the
   * role.
   * * [`AccessControlError::RoleIsEmpty`] - If the role has no members.
   * 
   * # Events
   * 
   * * topics - `["role_revoked", role: Symbol, account: Address]`
   * * data - `[caller: Address]`
   */
  renounce_role: ({role, caller}: {role: string, caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_role_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the admin role for a specific role.
   * If no admin role is explicitly set, returns `None`.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * * `role` - The role to query the admin role for.
   */
  get_role_admin: ({role}: {role: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a record_advance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  record_advance: ({user_ref, amount, fee}: {user_ref: Buffer, amount: i128, fee: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a renounce_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Allows the current admin to renounce their role, making the contract
   * permanently admin-less. This is useful for decentralization purposes
   * or when the admin role is no longer needed. Once the admin is
   * renounced, it cannot be reinstated.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * 
   * # Errors
   * 
   * * [`AccessControlError::AdminNotSet`] - If no admin account is set.
   * 
   * # Events
   * 
   * * topics - `["admin_renounced", admin: Address]`
   * * data - `[]`
   * 
   * # Notes
   * 
   * * Authorization for the current admin is required.
   */
  renounce_admin: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_role_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets `admin_role` as the admin role of `role`.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * * `role` - The role to set the admin for.
   * * `admin_role` - The new admin role.
   * 
   * # Events
   * 
   * * topics - `["role_admin_changed", role: Symbol]`
   * * data - `[previous_admin_role: Symbol, new_admin_role: Symbol]`
   * 
   * # Errors
   * 
   * * [`AccessControlError::AdminNotSet`] - If admin account is not set.
   * 
   * # Notes
   * 
   * * Authorization for the current admin is required.
   */
  set_role_admin: ({role, admin_role}: {role: string, admin_role: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_role_member transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the account at the specified index for a given role.
   * 
   * A function to get all members of a role is not provided because that
   * would be unbounded. To enumerate all members of a role, use
   * [`AccessControl::get_role_member_count()`] to get the total number of
   * members and then use [`AccessControl::get_role_member()`] to retrieve
   * each member one by one.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * * `role` - The role to query.
   * * `index` - The index of the account to retrieve.
   * 
   * # Errors
   * 
   * * [`AccessControlError::IndexOutOfBounds`] - If the index is out of
   * bounds for the role's member list.
   */
  get_role_member: ({role, index}: {role: string, index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a request_advance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  request_advance: ({user, asset, amount}: {user: string, asset: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a group_contribute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  group_contribute: ({user, group_id}: {user: string, group_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a record_repayment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  record_repayment: ({user_ref, amount, payment_ref}: {user_ref: Buffer, amount: i128, payment_ref: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_credit_limit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_credit_limit: ({borrower, limit}: {borrower: Party, limit: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_existing_roles transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns a vector containing all existing roles.
   * Defaults to empty vector if no roles exist.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * 
   * # Notes
   * 
   * This function returns all roles that currently have at least one member.
   * The maximum number of roles is limited by [`MAX_ROLES`].
   */
  get_existing_roles: (options?: MethodOptions) => Promise<AssembledTransaction<Array<string>>>

  /**
   * Construct and simulate a transfer_admin_role transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Initiates the admin role transfer.
   * Admin privileges for the current admin are not revoked until the
   * recipient accepts the transfer.
   * Overrides the previous pending transfer if there is one.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * * `new_admin` - The account to transfer the admin privileges to.
   * * `live_until_ledger` - The ledger number at which the pending transfer
   * expires. If `live_until_ledger` is `0`, the pending transfer is
   * cancelled. `live_until_ledger` argument is implicitly bounded by the
   * maximum allowed TTL extension for a temporary storage entry and
   * specifying a higher value will cause the code to panic.
   * 
   * # Errors
   * 
   * * [`crate::role_transfer::RoleTransferError::NoPendingTransfer`] - If
   * trying to cancel a transfer that doesn't exist.
   * * [`crate::role_transfer::RoleTransferError::InvalidLiveUntilLedger`] -
   * If the specified ledger is in the past.
   * * [`crate::role_transfer::RoleTransferError::InvalidPendingAccount`] -
   * If the specified pending account is not the same as the provided `new`
   * address.
   * 
   */
  transfer_admin_role: ({new_admin, live_until_ledger}: {new_admin: string, live_until_ledger: u32}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a accept_admin_transfer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Completes the 2-step admin transfer.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * 
   * # Events
   * 
   * * topics - `["admin_transfer_completed", new_admin: Address]`
   * * data - `[previous_admin: Address]`
   * 
   * # Errors
   * 
   * * [`crate::role_transfer::RoleTransferError::NoPendingTransfer`] - If
   * there is no pending transfer to accept.
   * * [`AccessControlError::AdminNotSet`] - If admin account is not set.
   */
  accept_admin_transfer: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_role_member_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the total number of accounts that have the specified role.
   * If the role does not exist, returns 0.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * * `role` - The role to get the count for.
   */
  get_role_member_count: ({role}: {role: string}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, partner, usdc, advance_fee_bps}: {admin: string, partner: string, usdc: string, advance_fee_bps: u32},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, partner, usdc, advance_fee_bps}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAQAAAAAAAAAAAAAAA1BvdAAAAAAHAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAAB2JhbGFuY2UAAAAACwAAAAAAAAAMbmV4dF9yZWxlYXNlAAAABgAAAAAAAAAJcGF5b3V0X3RvAAAAAAAAEwAAAAAAAAAKcGVyX3BlcmlvZAAAAAAACwAAABwwIG1lYW5zIG1hbnVhbCByZWxlYXNlIG9ubHkuAAAAC3BlcmlvZF9zZWNzAAAAAAYAAAAAAAAABnNlbmRlcgAAAAAAEw==",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAADwAAAAAAAAANTm90QXV0aG9yaXplZAAAAAAAAAEAAAAAAAAABlBhdXNlZAAAAAAAAgAAAAAAAAANSW52YWxpZEFtb3VudAAAAAAAAAMAAAAAAAAAD0Fzc2V0Tm90QWxsb3dlZAAAAAAEAAAAAAAAAAhOb3RGb3VuZAAAAAUAAAAAAAAACU5vdE1lbWJlcgAAAAAAAAYAAAAAAAAACVdyb25nTW9kZQAAAAAAAAcAAAAAAAAAEkFscmVhZHlDb250cmlidXRlZAAAAAAACAAAAAAAAAAGTm90RHVlAAAAAAAJAAAAAAAAAAlPdmVyTGltaXQAAAAAAAAKAAAAAAAAAAtBZHZhbmNlT3BlbgAAAAALAAAAAAAAAAlOb0FkdmFuY2UAAAAAAAAMAAAAAAAAABBJbnN1ZmZpY2llbnRQb29sAAAADQAAAAAAAAATSW5zdWZmaWNpZW50QmFsYW5jZQAAAAAOAAAAAAAAAA9EdXBsaWNhdGVNZW1iZXIAAAAADw==",
        "AAAAAQAAAAAAAAAAAAAABUdyb3VwAAAAAAAACgAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAAC2NvbnRyaWJ1dGVkAAAAA+oAAAABAAAAAAAAAAdtZW1iZXJzAAAAA+oAAAfQAAAABVBhcnR5AAAAAAAAAAAAAAhuZXh0X2R1ZQAAAAYAAAAAAAAACW9yZ2FuaXplcgAAAAAAABMAAAAAAAAAC3BlcmlvZF9zZWNzAAAAAAYAAAAAAAAABnBvb2xlZAAAAAAAAQAAAAAAAAADcG90AAAAAAsAAAAAAAAABHR1cm4AAAAE",
        "AAAAAgAAAE5BIHBhcnRpY2lwYW50OiBlaXRoZXIgYSBTdGVsbGFyIGFjY291bnQgb3IgYSAzMi1ieXRlIG9mZi1jaGFpbiByZWZlcmVuY2UgaGFzaC4AAAAAAAAAAAAFUGFydHkAAAAAAAACAAAAAQAAAAAAAAAHQWNjb3VudAAAAAABAAAAEwAAAAEAAAAAAAAAA1JlZgAAAAABAAAD7gAAACA=",
        "AAAAAQAAAFNQdWJsaWMgdmlldyBvZiB0aGUgY29uZmlndXJhdGlvbi4gYGFkbWluYCBpcyByZWFkIGZyb20gT3BlblplcHBlbGluIGFjY2VzcyBjb250cm9sLgAAAAAAAAAABkNvbmZpZwAAAAAABAAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAA9hZHZhbmNlX2ZlZV9icHMAAAAABAAAAAAAAAAGYXNzZXRzAAAAAAPqAAAAEwAAAAAAAAAHcGFydG5lcgAAAAAT",
        "AAAABQAAAAAAAAAAAAAABlJlcGFpZAAAAAAAAQAAAAZyZXBhaWQAAAAAAAMAAAAAAAAABHVzZXIAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAAEb3dlZAAAAAsAAAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAAB0FkdmFuY2UAAAAABQAAAEVTZXQgb25seSBmb3IgYFBhcnR5OjpBY2NvdW50YCBhZHZhbmNlcyBwYWlkIG91dCBvZiB0aGUgb24tY2hhaW4gcG9vbC4AAAAAAAAFYXNzZXQAAAAAAAPoAAAAEwAAAAAAAAADZmVlAAAAAAsAAAAAAAAACW9wZW5lZF90cwAAAAAAAAYAAAAAAAAABG93ZWQAAAALAAAAAAAAAAlwcmluY2lwYWwAAAAAAAAL",
        "AAAABQAAAAAAAAAAAAAAB1BhaWRPdXQAAAAAAQAAAAhwYWlkX291dAAAAAUAAAAAAAAACGdyb3VwX2lkAAAABAAAAAEAAAAAAAAAAnRvAAAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAAOYWR2YW5jZV9yZXBhaWQAAAAAAAsAAAAAAAAAAAAAAAR0dXJuAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAACEF0dGVzdGVkAAAAAQAAAAhhdHRlc3RlZAAAAAQAAAAAAAAACHVzZXJfcmVmAAAD7gAAACAAAAABAAAAAAAAAARraW5kAAAH0AAAAApBdHRlc3RLaW5kAAAAAAAAAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAAAAAAtwYXltZW50X3JlZgAAAAPuAAAAIAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAACExpbWl0U2V0AAAAAQAAAAlsaW1pdF9zZXQAAAAAAAACAAAAAAAAAAhib3Jyb3dlcgAAB9AAAAAFUGFydHkAAAAAAAABAAAAAAAAAAVsaW1pdAAAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAACVBvdEZ1bmRlZAAAAAAAAAEAAAAKcG90X2Z1bmRlZAAAAAAAAwAAAAAAAAAGcG90X2lkAAAAAAAEAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAAHYmFsYW5jZQAAAAALAAAAAAAAAAI=",
        "AAAAAwAAAAAAAAAAAAAACkF0dGVzdEtpbmQAAAAAAAMAAAAAAAAACFJlY2VpdmVkAAAAAAAAAAAAAAAFU2F2ZWQAAAAAAAABAAAAAAAAAARQYWlkAAAAAg==",
        "AAAABQAAAAAAAAAAAAAACkFzc2V0QWRkZWQAAAAAAAEAAAALYXNzZXRfYWRkZWQAAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAI=",
        "AAAABQAAAAAAAAAAAAAAClBvb2xGdW5kZWQAAAAAAAEAAAALcG9vbF9mdW5kZWQAAAAAAwAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAAHYmFsYW5jZQAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAClBvdENyZWF0ZWQAAAAAAAEAAAALcG90X2NyZWF0ZWQAAAAAAwAAAAAAAAAGcG90X2lkAAAAAAAEAAAAAQAAAAAAAAAGc2VuZGVyAAAAAAATAAAAAAAAAAAAAAAJcGF5b3V0X3RvAAAAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAC0NvbnRyaWJ1dGVkAAAAAAEAAAALY29udHJpYnV0ZWQAAAAAAwAAAAAAAAAIZ3JvdXBfaWQAAAAEAAAAAQAAAAAAAAAEdXNlcgAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAC1BvdFJlbGVhc2VkAAAAAAEAAAAMcG90X3JlbGVhc2VkAAAABAAAAAAAAAAGcG90X2lkAAAAAAAEAAAAAQAAAAAAAAACdG8AAAAAABMAAAAAAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAAAAAAdiYWxhbmNlAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADEdyb3VwQ3JlYXRlZAAAAAEAAAANZ3JvdXBfY3JlYXRlZAAAAAAAAAMAAAAAAAAACGdyb3VwX2lkAAAABAAAAAEAAAAAAAAACW9yZ2FuaXplcgAAAAAAABMAAAAAAAAAAAAAAAZwb29sZWQAAAAAAAEAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADFBvdENhbmNlbGxlZAAAAAEAAAANcG90X2NhbmNlbGxlZAAAAAAAAAIAAAAAAAAABnBvdF9pZAAAAAAABAAAAAEAAAAAAAAACHJlZnVuZGVkAAAACwAAAAAAAAAC",
        "AAAAAQAAAAAAAAAAAAAADVJlY29yZFN1bW1hcnkAAAAAAAAHAAAAAAAAAAVjb3VudAAAAAAAAAQAAAAAAAAACGZpcnN0X3RzAAAABgAAAAAAAAAHbGFzdF90cwAAAAAGAAAAAAAAAAt0b3RhbF9ncm91cAAAAAALAAAAAAAAAAp0b3RhbF9wYWlkAAAAAAALAAAAAAAAAA50b3RhbF9yZWNlaXZlZAAAAAAACwAAAAAAAAALdG90YWxfc2F2ZWQAAAAACw==",
        "AAAABQAAAAAAAAAAAAAADUFkdmFuY2VJc3N1ZWQAAAAAAAABAAAADmFkdmFuY2VfaXNzdWVkAAAAAAAFAAAAAAAAAAR1c2VyAAAAEwAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAAAAAACXByaW5jaXBhbAAAAAAAAAsAAAAAAAAAAAAAAANmZWUAAAAACwAAAAAAAAAAAAAABG93ZWQAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD0FkdmFuY2VSZWNvcmRlZAAAAAABAAAAEGFkdmFuY2VfcmVjb3JkZWQAAAAEAAAAAAAAAAh1c2VyX3JlZgAAA+4AAAAgAAAAAQAAAAAAAAAJcHJpbmNpcGFsAAAAAAAACwAAAAAAAAAAAAAAA2ZlZQAAAAALAAAAAAAAAAAAAAAEb3dlZAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAEVJlcGF5bWVudFJlY29yZGVkAAAAAAAAAQAAABJyZXBheW1lbnRfcmVjb3JkZWQAAAAAAAQAAAAAAAAACHVzZXJfcmVmAAAD7gAAACAAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAAAAAARvd2VkAAAACwAAAAAAAAAAAAAAC3BheW1lbnRfcmVmAAAAA+4AAAAgAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAFENvbnRyaWJ1dGlvblJlY29yZGVkAAAAAQAAABVjb250cmlidXRpb25fcmVjb3JkZWQAAAAAAAAEAAAAAAAAAAhncm91cF9pZAAAAAQAAAABAAAAAAAAAAptZW1iZXJfcmVmAAAAAAPuAAAAIAAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAAAAAAC3BheW1lbnRfcmVmAAAAA+4AAAAgAAAAAAAAAAI=",
        "AAAAAAAAAAAAAAADcG90AAAAAAEAAAAAAAAABnBvdF9pZAAAAAAABAAAAAEAAAPpAAAH0AAAAANQb3QAAAAAAw==",
        "AAAAAAAAAAAAAAAFZ3JvdXAAAAAAAAABAAAAAAAAAAhncm91cF9pZAAAAAQAAAABAAAD6QAAB9AAAAAFR3JvdXAAAAAAAAAD",
        "AAAAAAAAAAAAAAAFcGF1c2UAAAAAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAFcmVwYXkAAAAAAAACAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAGYXR0ZXN0AAAAAAAEAAAAAAAAAAh1c2VyX3JlZgAAA+4AAAAgAAAAAAAAAARraW5kAAAH0AAAAApBdHRlc3RLaW5kAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAALcGF5bWVudF9yZWYAAAAD7gAAACAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAGY29uZmlnAAAAAAAAAAAAAQAAB9AAAAAGQ29uZmlnAAA=",
        "AAAAAAAAAAAAAAAGcGF1c2VkAAAAAAAAAAAAAQAAAAE=",
        "AAAAAAAAAAAAAAAHdW5wYXVzZQAAAAAAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAXJSZXR1cm5zIGBTb21lKGluZGV4KWAgaWYgdGhlIGFjY291bnQgaGFzIHRoZSBzcGVjaWZpZWQgcm9sZSwKd2hlcmUgYGluZGV4YCBpcyB0aGUgcG9zaXRpb24gb2YgdGhlIGFjY291bnQgZm9yIHRoYXQgcm9sZSwKYW5kIGNhbiBiZSB1c2VkIHRvIHF1ZXJ5IFtgQWNjZXNzQ29udHJvbDo6Z2V0X3JvbGVfbWVtYmVyKClgXS4KUmV0dXJucyBgTm9uZWAgaWYgdGhlIGFjY291bnQgZG9lcyBub3QgaGF2ZSB0aGUgc3BlY2lmaWVkIHJvbGUuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgYWNjb3VudGAgLSBUaGUgYWNjb3VudCB0byBjaGVjay4KKiBgcm9sZWAgLSBUaGUgcm9sZSB0byBjaGVjayBmb3IuAAAAAAAIaGFzX3JvbGUAAAACAAAAAAAAAAdhY2NvdW50AAAAABMAAAAAAAAABHJvbGUAAAARAAAAAQAAA+gAAAAE",
        "AAAAAAAAAAAAAAAIbGltaXRfb2YAAAABAAAAAAAAAAVwYXJ0eQAAAAAAB9AAAAAFUGFydHkAAAAAAAABAAAACw==",
        "AAAAAAAAAAAAAAAIcG90X2Z1bmQAAAADAAAAAAAAAAZzZW5kZXIAAAAAABMAAAAAAAAABnBvdF9pZAAAAAAABAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAIcG90X3NlbmQAAAADAAAAAAAAAAZzZW5kZXIAAAAAABMAAAAAAAAABnBvdF9pZAAAAAAABAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAJYWRkX2Fzc2V0AAAAAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAJZnVuZF9wb29sAAAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAE9SZXR1cm5zIHRoZSBhZG1pbiBhY2NvdW50LgoKIyBBcmd1bWVudHMKCiogYGVgIC0gQWNjZXNzIHRvIFNvcm9iYW4gZW52aXJvbm1lbnQuAAAAAAlnZXRfYWRtaW4AAAAAAAAAAAAAAQAAA+gAAAAT",
        "AAAAAAAAAAAAAAAJcmVjb3JkX29mAAAAAAAAAQAAAAAAAAAIdXNlcl9yZWYAAAPuAAAAIAAAAAEAAAfQAAAADVJlY29yZFN1bW1hcnkAAAA=",
        "AAAAAAAAAAAAAAAKYWR2YW5jZV9vZgAAAAAAAQAAAAAAAAAFcGFydHkAAAAAAAfQAAAABVBhcnR5AAAAAAAAAQAAA+gAAAfQAAAAB0FkdmFuY2UA",
        "AAAAAAAAAj5HcmFudHMgYSByb2xlIHRvIGFuIGFjY291bnQuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgYWNjb3VudGAgLSBUaGUgYWNjb3VudCB0byBncmFudCB0aGUgcm9sZSB0by4KKiBgcm9sZWAgLSBUaGUgcm9sZSB0byBncmFudC4KKiBgY2FsbGVyYCAtIFRoZSBhZGRyZXNzIG9mIHRoZSBjYWxsZXIsIG11c3QgYmUgdGhlIGFkbWluIG9yIGhhdmUgdGhlCmBSb2xlQWRtaW5gIGZvciB0aGUgYHJvbGVgLgoKIyBFcnJvcnMKCiogW2BBY2Nlc3NDb250cm9sRXJyb3I6OlVuYXV0aG9yaXplZGBdIC0gSWYgdGhlIGNhbGxlciBkb2VzIG5vdCBoYXZlCmVub3VnaCBwcml2aWxlZ2VzLgoqIFtgQWNjZXNzQ29udHJvbEVycm9yOjpNYXhSb2xlc0V4Y2VlZGVkYF0gLSBJZiBhZGRpbmcgYSBuZXcgcm9sZSB3b3VsZApleGNlZWQgdGhlIG1heGltdW0gYWxsb3dlZCBudW1iZXIgb2Ygcm9sZXMuCgojIEV2ZW50cwoKKiB0b3BpY3MgLSBgWyJyb2xlX2dyYW50ZWQiLCByb2xlOiBTeW1ib2wsIGFjY291bnQ6IEFkZHJlc3NdYAoqIGRhdGEgLSBgW2NhbGxlcjogQWRkcmVzc11gAAAAAAAKZ3JhbnRfcm9sZQAAAAAAAwAAAAAAAAAHYWNjb3VudAAAAAATAAAAAAAAAARyb2xlAAAAEQAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAA==",
        "AAAAAAAAAAAAAAAKcG90X2NhbmNlbAAAAAAAAgAAAAAAAAAGc2VuZGVyAAAAAAATAAAAAAAAAAZwb3RfaWQAAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAKcG90X2NyZWF0ZQAAAAAABQAAAAAAAAAGc2VuZGVyAAAAAAATAAAAAAAAAAlwYXlvdXRfdG8AAAAAAAATAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAACnBlcl9wZXJpb2QAAAAAAAsAAAAAAAAAC3BlcmlvZF9zZWNzAAAAAAYAAAABAAAD6QAAAAQAAAAD",
        "AAAAAAAAAAAAAAALcG90X3JlbGVhc2UAAAAAAQAAAAAAAAAGcG90X2lkAAAAAAAEAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAArdSZXZva2VzIGEgcm9sZSBmcm9tIGFuIGFjY291bnQuClRvIHJldm9rZSB0aGUgY2FsbGVyJ3Mgb3duIHJvbGUsIHVzZQpbYEFjY2Vzc0NvbnRyb2w6OnJlbm91bmNlX3JvbGUoKWBdIGluc3RlYWQuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgYWNjb3VudGAgLSBUaGUgYWNjb3VudCB0byByZXZva2UgdGhlIHJvbGUgZnJvbS4KKiBgcm9sZWAgLSBUaGUgcm9sZSB0byByZXZva2UuCiogYGNhbGxlcmAgLSBUaGUgYWRkcmVzcyBvZiB0aGUgY2FsbGVyLCBtdXN0IGJlIHRoZSBhZG1pbiBvciBoYXMgdGhlCmBSb2xlQWRtaW5gIGZvciB0aGUgYHJvbGVgLgoKIyBFcnJvcnMKCiogW2BBY2Nlc3NDb250cm9sRXJyb3I6OlVuYXV0aG9yaXplZGBdIC0gSWYgdGhlIGBjYWxsZXJgIGRvZXMgbm90IGhhdmUKZW5vdWdoIHByaXZpbGVnZXMuCiogW2BBY2Nlc3NDb250cm9sRXJyb3I6OlJvbGVOb3RIZWxkYF0gLSBJZiB0aGUgYGFjY291bnRgIGRvZXNuJ3QgaGF2ZQp0aGUgcm9sZS4KKiBbYEFjY2Vzc0NvbnRyb2xFcnJvcjo6Um9sZUlzRW1wdHlgXSAtIElmIHRoZSByb2xlIGhhcyBubyBtZW1iZXJzLgoKIyBFdmVudHMKCiogdG9waWNzIC0gYFsicm9sZV9yZXZva2VkIiwgcm9sZTogU3ltYm9sLCBhY2NvdW50OiBBZGRyZXNzXWAKKiBkYXRhIC0gYFtjYWxsZXI6IEFkZHJlc3NdYAAAAAALcmV2b2tlX3JvbGUAAAAAAwAAAAAAAAAHYWNjb3VudAAAAAATAAAAAAAAAARyb2xlAAAAEQAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAA==",
        "AAAAAAAAAAAAAAAMZ3JvdXBfY3JlYXRlAAAABgAAAAAAAAAJb3JnYW5pemVyAAAAAAAAEwAAAAAAAAAHbWVtYmVycwAAAAPqAAAH0AAAAAVQYXJ0eQAAAAAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAC3BlcmlvZF9zZWNzAAAAAAYAAAAAAAAABnBvb2xlZAAAAAAAAQAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAAAAAAAAMZ3JvdXBfcGF5b3V0AAAAAQAAAAAAAAAIZ3JvdXBfaWQAAAAEAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAMZ3JvdXBfcmVjb3JkAAAABAAAAAAAAAAIZ3JvdXBfaWQAAAAEAAAAAAAAAAptZW1iZXJfcmVmAAAAAAPuAAAAIAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAtwYXltZW50X3JlZgAAAAPuAAAAIAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAMcG9vbF9iYWxhbmNlAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAs=",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAQAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAHcGFydG5lcgAAAAATAAAAAAAAAAR1c2RjAAAAEwAAAAAAAAAPYWR2YW5jZV9mZWVfYnBzAAAAAAQAAAAA",
        "AAAAAAAAAhZBbGxvd3MgYW4gYWNjb3VudCB0byByZW5vdW5jZSBhIHJvbGUgYXNzaWduZWQgdG8gaXRzZWxmLgpVc2VycyBjYW4gb25seSByZW5vdW5jZSByb2xlcyBmb3IgdGhlaXIgb3duIGFjY291bnQuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgcm9sZWAgLSBUaGUgcm9sZSB0byByZW5vdW5jZS4KKiBgY2FsbGVyYCAtIFRoZSBhZGRyZXNzIG9mIHRoZSBjYWxsZXIsIG11c3QgYmUgdGhlIGFjY291bnQgdGhhdCBoYXMgdGhlCnJvbGUuCgojIEVycm9ycwoKKiBbYEFjY2Vzc0NvbnRyb2xFcnJvcjo6Um9sZU5vdEhlbGRgXSAtIElmIHRoZSBgY2FsbGVyYCBkb2Vzbid0IGhhdmUgdGhlCnJvbGUuCiogW2BBY2Nlc3NDb250cm9sRXJyb3I6OlJvbGVJc0VtcHR5YF0gLSBJZiB0aGUgcm9sZSBoYXMgbm8gbWVtYmVycy4KCiMgRXZlbnRzCgoqIHRvcGljcyAtIGBbInJvbGVfcmV2b2tlZCIsIHJvbGU6IFN5bWJvbCwgYWNjb3VudDogQWRkcmVzc11gCiogZGF0YSAtIGBbY2FsbGVyOiBBZGRyZXNzXWAAAAAAAA1yZW5vdW5jZV9yb2xlAAAAAAAAAgAAAAAAAAAEcm9sZQAAABEAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAA=",
        "AAAAAAAAAMVSZXR1cm5zIHRoZSBhZG1pbiByb2xlIGZvciBhIHNwZWNpZmljIHJvbGUuCklmIG5vIGFkbWluIHJvbGUgaXMgZXhwbGljaXRseSBzZXQsIHJldHVybnMgYE5vbmVgLgoKIyBBcmd1bWVudHMKCiogYGVgIC0gQWNjZXNzIHRvIFNvcm9iYW4gZW52aXJvbm1lbnQuCiogYHJvbGVgIC0gVGhlIHJvbGUgdG8gcXVlcnkgdGhlIGFkbWluIHJvbGUgZm9yLgAAAAAAAA5nZXRfcm9sZV9hZG1pbgAAAAAAAQAAAAAAAAAEcm9sZQAAABEAAAABAAAD6AAAABE=",
        "AAAAAAAAAAAAAAAOcmVjb3JkX2FkdmFuY2UAAAAAAAMAAAAAAAAACHVzZXJfcmVmAAAD7gAAACAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAADZmVlAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAfZBbGxvd3MgdGhlIGN1cnJlbnQgYWRtaW4gdG8gcmVub3VuY2UgdGhlaXIgcm9sZSwgbWFraW5nIHRoZSBjb250cmFjdApwZXJtYW5lbnRseSBhZG1pbi1sZXNzLiBUaGlzIGlzIHVzZWZ1bCBmb3IgZGVjZW50cmFsaXphdGlvbiBwdXJwb3NlcwpvciB3aGVuIHRoZSBhZG1pbiByb2xlIGlzIG5vIGxvbmdlciBuZWVkZWQuIE9uY2UgdGhlIGFkbWluIGlzCnJlbm91bmNlZCwgaXQgY2Fubm90IGJlIHJlaW5zdGF0ZWQuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gU29yb2JhbiBlbnZpcm9ubWVudC4KCiMgRXJyb3JzCgoqIFtgQWNjZXNzQ29udHJvbEVycm9yOjpBZG1pbk5vdFNldGBdIC0gSWYgbm8gYWRtaW4gYWNjb3VudCBpcyBzZXQuCgojIEV2ZW50cwoKKiB0b3BpY3MgLSBgWyJhZG1pbl9yZW5vdW5jZWQiLCBhZG1pbjogQWRkcmVzc11gCiogZGF0YSAtIGBbXWAKCiMgTm90ZXMKCiogQXV0aG9yaXphdGlvbiBmb3IgdGhlIGN1cnJlbnQgYWRtaW4gaXMgcmVxdWlyZWQuAAAAAAAOcmVub3VuY2VfYWRtaW4AAAAAAAAAAAAA",
        "AAAAAAAAAb1TZXRzIGBhZG1pbl9yb2xlYCBhcyB0aGUgYWRtaW4gcm9sZSBvZiBgcm9sZWAuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgcm9sZWAgLSBUaGUgcm9sZSB0byBzZXQgdGhlIGFkbWluIGZvci4KKiBgYWRtaW5fcm9sZWAgLSBUaGUgbmV3IGFkbWluIHJvbGUuCgojIEV2ZW50cwoKKiB0b3BpY3MgLSBgWyJyb2xlX2FkbWluX2NoYW5nZWQiLCByb2xlOiBTeW1ib2xdYAoqIGRhdGEgLSBgW3ByZXZpb3VzX2FkbWluX3JvbGU6IFN5bWJvbCwgbmV3X2FkbWluX3JvbGU6IFN5bWJvbF1gCgojIEVycm9ycwoKKiBbYEFjY2Vzc0NvbnRyb2xFcnJvcjo6QWRtaW5Ob3RTZXRgXSAtIElmIGFkbWluIGFjY291bnQgaXMgbm90IHNldC4KCiMgTm90ZXMKCiogQXV0aG9yaXphdGlvbiBmb3IgdGhlIGN1cnJlbnQgYWRtaW4gaXMgcmVxdWlyZWQuAAAAAAAADnNldF9yb2xlX2FkbWluAAAAAAACAAAAAAAAAARyb2xlAAAAEQAAAAAAAAAKYWRtaW5fcm9sZQAAAAAAEQAAAAA=",
        "AAAAAAAAAllSZXR1cm5zIHRoZSBhY2NvdW50IGF0IHRoZSBzcGVjaWZpZWQgaW5kZXggZm9yIGEgZ2l2ZW4gcm9sZS4KCkEgZnVuY3Rpb24gdG8gZ2V0IGFsbCBtZW1iZXJzIG9mIGEgcm9sZSBpcyBub3QgcHJvdmlkZWQgYmVjYXVzZSB0aGF0CndvdWxkIGJlIHVuYm91bmRlZC4gVG8gZW51bWVyYXRlIGFsbCBtZW1iZXJzIG9mIGEgcm9sZSwgdXNlCltgQWNjZXNzQ29udHJvbDo6Z2V0X3JvbGVfbWVtYmVyX2NvdW50KClgXSB0byBnZXQgdGhlIHRvdGFsIG51bWJlciBvZgptZW1iZXJzIGFuZCB0aGVuIHVzZSBbYEFjY2Vzc0NvbnRyb2w6OmdldF9yb2xlX21lbWJlcigpYF0gdG8gcmV0cmlldmUKZWFjaCBtZW1iZXIgb25lIGJ5IG9uZS4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byBTb3JvYmFuIGVudmlyb25tZW50LgoqIGByb2xlYCAtIFRoZSByb2xlIHRvIHF1ZXJ5LgoqIGBpbmRleGAgLSBUaGUgaW5kZXggb2YgdGhlIGFjY291bnQgdG8gcmV0cmlldmUuCgojIEVycm9ycwoKKiBbYEFjY2Vzc0NvbnRyb2xFcnJvcjo6SW5kZXhPdXRPZkJvdW5kc2BdIC0gSWYgdGhlIGluZGV4IGlzIG91dCBvZgpib3VuZHMgZm9yIHRoZSByb2xlJ3MgbWVtYmVyIGxpc3QuAAAAAAAAD2dldF9yb2xlX21lbWJlcgAAAAACAAAAAAAAAARyb2xlAAAAEQAAAAAAAAAFaW5kZXgAAAAAAAAEAAAAAQAAABM=",
        "AAAAAAAAAAAAAAAPcmVxdWVzdF9hZHZhbmNlAAAAAAMAAAAAAAAABHVzZXIAAAATAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAQZ3JvdXBfY29udHJpYnV0ZQAAAAIAAAAAAAAABHVzZXIAAAATAAAAAAAAAAhncm91cF9pZAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAQcmVjb3JkX3JlcGF5bWVudAAAAAMAAAAAAAAACHVzZXJfcmVmAAAD7gAAACAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAALcGF5bWVudF9yZWYAAAAD7gAAACAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAQc2V0X2NyZWRpdF9saW1pdAAAAAIAAAAAAAAACGJvcnJvd2VyAAAH0AAAAAVQYXJ0eQAAAAAAAAAAAAAFbGltaXQAAAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAARxSZXR1cm5zIGEgdmVjdG9yIGNvbnRhaW5pbmcgYWxsIGV4aXN0aW5nIHJvbGVzLgpEZWZhdWx0cyB0byBlbXB0eSB2ZWN0b3IgaWYgbm8gcm9sZXMgZXhpc3QuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gU29yb2JhbiBlbnZpcm9ubWVudC4KCiMgTm90ZXMKClRoaXMgZnVuY3Rpb24gcmV0dXJucyBhbGwgcm9sZXMgdGhhdCBjdXJyZW50bHkgaGF2ZSBhdCBsZWFzdCBvbmUgbWVtYmVyLgpUaGUgbWF4aW11bSBudW1iZXIgb2Ygcm9sZXMgaXMgbGltaXRlZCBieSBbYE1BWF9ST0xFU2BdLgAAABJnZXRfZXhpc3Rpbmdfcm9sZXMAAAAAAAAAAAABAAAD6gAAABE=",
        "AAAAAAAABABJbml0aWF0ZXMgdGhlIGFkbWluIHJvbGUgdHJhbnNmZXIuCkFkbWluIHByaXZpbGVnZXMgZm9yIHRoZSBjdXJyZW50IGFkbWluIGFyZSBub3QgcmV2b2tlZCB1bnRpbCB0aGUKcmVjaXBpZW50IGFjY2VwdHMgdGhlIHRyYW5zZmVyLgpPdmVycmlkZXMgdGhlIHByZXZpb3VzIHBlbmRpbmcgdHJhbnNmZXIgaWYgdGhlcmUgaXMgb25lLgoKIyBBcmd1bWVudHMKCiogYGVgIC0gQWNjZXNzIHRvIFNvcm9iYW4gZW52aXJvbm1lbnQuCiogYG5ld19hZG1pbmAgLSBUaGUgYWNjb3VudCB0byB0cmFuc2ZlciB0aGUgYWRtaW4gcHJpdmlsZWdlcyB0by4KKiBgbGl2ZV91bnRpbF9sZWRnZXJgIC0gVGhlIGxlZGdlciBudW1iZXIgYXQgd2hpY2ggdGhlIHBlbmRpbmcgdHJhbnNmZXIKZXhwaXJlcy4gSWYgYGxpdmVfdW50aWxfbGVkZ2VyYCBpcyBgMGAsIHRoZSBwZW5kaW5nIHRyYW5zZmVyIGlzCmNhbmNlbGxlZC4gYGxpdmVfdW50aWxfbGVkZ2VyYCBhcmd1bWVudCBpcyBpbXBsaWNpdGx5IGJvdW5kZWQgYnkgdGhlCm1heGltdW0gYWxsb3dlZCBUVEwgZXh0ZW5zaW9uIGZvciBhIHRlbXBvcmFyeSBzdG9yYWdlIGVudHJ5IGFuZApzcGVjaWZ5aW5nIGEgaGlnaGVyIHZhbHVlIHdpbGwgY2F1c2UgdGhlIGNvZGUgdG8gcGFuaWMuCgojIEVycm9ycwoKKiBbYGNyYXRlOjpyb2xlX3RyYW5zZmVyOjpSb2xlVHJhbnNmZXJFcnJvcjo6Tm9QZW5kaW5nVHJhbnNmZXJgXSAtIElmCnRyeWluZyB0byBjYW5jZWwgYSB0cmFuc2ZlciB0aGF0IGRvZXNuJ3QgZXhpc3QuCiogW2BjcmF0ZTo6cm9sZV90cmFuc2Zlcjo6Um9sZVRyYW5zZmVyRXJyb3I6OkludmFsaWRMaXZlVW50aWxMZWRnZXJgXSAtCklmIHRoZSBzcGVjaWZpZWQgbGVkZ2VyIGlzIGluIHRoZSBwYXN0LgoqIFtgY3JhdGU6OnJvbGVfdHJhbnNmZXI6OlJvbGVUcmFuc2ZlckVycm9yOjpJbnZhbGlkUGVuZGluZ0FjY291bnRgXSAtCklmIHRoZSBzcGVjaWZpZWQgcGVuZGluZyBhY2NvdW50IGlzIG5vdCB0aGUgc2FtZSBhcyB0aGUgcHJvdmlkZWQgYG5ld2AKYWRkcmVzcy4KAAAAE3RyYW5zZmVyX2FkbWluX3JvbGUAAAAAAgAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAAAAAARbGl2ZV91bnRpbF9sZWRnZXIAAAAAAAAEAAAAAA==",
        "AAAAAAAAAYVDb21wbGV0ZXMgdGhlIDItc3RlcCBhZG1pbiB0cmFuc2Zlci4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byBTb3JvYmFuIGVudmlyb25tZW50LgoKIyBFdmVudHMKCiogdG9waWNzIC0gYFsiYWRtaW5fdHJhbnNmZXJfY29tcGxldGVkIiwgbmV3X2FkbWluOiBBZGRyZXNzXWAKKiBkYXRhIC0gYFtwcmV2aW91c19hZG1pbjogQWRkcmVzc11gCgojIEVycm9ycwoKKiBbYGNyYXRlOjpyb2xlX3RyYW5zZmVyOjpSb2xlVHJhbnNmZXJFcnJvcjo6Tm9QZW5kaW5nVHJhbnNmZXJgXSAtIElmCnRoZXJlIGlzIG5vIHBlbmRpbmcgdHJhbnNmZXIgdG8gYWNjZXB0LgoqIFtgQWNjZXNzQ29udHJvbEVycm9yOjpBZG1pbk5vdFNldGBdIC0gSWYgYWRtaW4gYWNjb3VudCBpcyBub3Qgc2V0LgAAAAAAABVhY2NlcHRfYWRtaW5fdHJhbnNmZXIAAAAAAAAAAAAAAA==",
        "AAAAAAAAAMhSZXR1cm5zIHRoZSB0b3RhbCBudW1iZXIgb2YgYWNjb3VudHMgdGhhdCBoYXZlIHRoZSBzcGVjaWZpZWQgcm9sZS4KSWYgdGhlIHJvbGUgZG9lcyBub3QgZXhpc3QsIHJldHVybnMgMC4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byBTb3JvYmFuIGVudmlyb25tZW50LgoqIGByb2xlYCAtIFRoZSByb2xlIHRvIGdldCB0aGUgY291bnQgZm9yLgAAABVnZXRfcm9sZV9tZW1iZXJfY291bnQAAAAAAAABAAAAAAAAAARyb2xlAAAAEQAAAAEAAAAE",
        "AAAABAAAAAAAAAAAAAAAEVJvbGVUcmFuc2ZlckVycm9yAAAAAAAABAAAAAAAAAARTm9QZW5kaW5nVHJhbnNmZXIAAAAAAAiYAAAAAAAAABZJbnZhbGlkTGl2ZVVudGlsTGVkZ2VyAAAAAAiZAAAAAAAAABVJbnZhbGlkUGVuZGluZ0FjY291bnQAAAAAAAiaAAAAAAAAAA9UcmFuc2ZlckV4cGlyZWQAAAAImw==",
        "AAAABQAAACVFdmVudCBlbWl0dGVkIHdoZW4gYSByb2xlIGlzIGdyYW50ZWQuAAAAAAAAAAAAAAtSb2xlR3JhbnRlZAAAAAABAAAADHJvbGVfZ3JhbnRlZAAAAAMAAAAAAAAABHJvbGUAAAARAAAAAQAAAAAAAAAHYWNjb3VudAAAAAATAAAAAQAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAI=",
        "AAAABQAAACVFdmVudCBlbWl0dGVkIHdoZW4gYSByb2xlIGlzIHJldm9rZWQuAAAAAAAAAAAAAAtSb2xlUmV2b2tlZAAAAAABAAAADHJvbGVfcmV2b2tlZAAAAAMAAAAAAAAABHJvbGUAAAARAAAAAQAAAAAAAAAHYWNjb3VudAAAAAATAAAAAQAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAI=",
        "AAAABQAAAC9FdmVudCBlbWl0dGVkIHdoZW4gdGhlIGFkbWluIHJvbGUgaXMgcmVub3VuY2VkLgAAAAAAAAAADkFkbWluUmVub3VuY2VkAAAAAAABAAAAD2FkbWluX3Jlbm91bmNlZAAAAAABAAAAAAAAAAVhZG1pbgAAAAAAABMAAAABAAAAAg==",
        "AAAABQAAACtFdmVudCBlbWl0dGVkIHdoZW4gYSByb2xlIGFkbWluIGlzIGNoYW5nZWQuAAAAAAAAAAAQUm9sZUFkbWluQ2hhbmdlZAAAAAEAAAAScm9sZV9hZG1pbl9jaGFuZ2VkAAAAAAADAAAAAAAAAARyb2xlAAAAEQAAAAEAAAAAAAAAE3ByZXZpb3VzX2FkbWluX3JvbGUAAAAAEQAAAAAAAAAAAAAADm5ld19hZG1pbl9yb2xlAAAAAAARAAAAAAAAAAI=",
        "AAAABAAAAAAAAAAAAAAAEkFjY2Vzc0NvbnRyb2xFcnJvcgAAAAAACwAAAAAAAAAMVW5hdXRob3JpemVkAAAH0AAAAAAAAAALQWRtaW5Ob3RTZXQAAAAH0QAAAAAAAAAQSW5kZXhPdXRPZkJvdW5kcwAAB9IAAAAAAAAAEUFkbWluUm9sZU5vdEZvdW5kAAAAAAAH0wAAAAAAAAASUm9sZUNvdW50SXNOb3RaZXJvAAAAAAfUAAAAAAAAAAxSb2xlTm90Rm91bmQAAAfVAAAAAAAAAA9BZG1pbkFscmVhZHlTZXQAAAAH1gAAAAAAAAALUm9sZU5vdEhlbGQAAAAH1wAAAAAAAAALUm9sZUlzRW1wdHkAAAAH2AAAAAAAAAASVHJhbnNmZXJJblByb2dyZXNzAAAAAAfZAAAAAAAAABBNYXhSb2xlc0V4Y2VlZGVkAAAH2g==",
        "AAAABQAAADJFdmVudCBlbWl0dGVkIHdoZW4gYW4gYWRtaW4gdHJhbnNmZXIgaXMgY29tcGxldGVkLgAAAAAAAAAAABZBZG1pblRyYW5zZmVyQ29tcGxldGVkAAAAAAABAAAAGGFkbWluX3RyYW5zZmVyX2NvbXBsZXRlZAAAAAIAAAAAAAAACW5ld19hZG1pbgAAAAAAABMAAAABAAAAAAAAAA5wcmV2aW91c19hZG1pbgAAAAAAEwAAAAAAAAAC",
        "AAAABQAAADJFdmVudCBlbWl0dGVkIHdoZW4gYW4gYWRtaW4gdHJhbnNmZXIgaXMgaW5pdGlhdGVkLgAAAAAAAAAAABZBZG1pblRyYW5zZmVySW5pdGlhdGVkAAAAAAABAAAAGGFkbWluX3RyYW5zZmVyX2luaXRpYXRlZAAAAAMAAAAAAAAADWN1cnJlbnRfYWRtaW4AAAAAAAATAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAAAAAAAAAAAEWxpdmVfdW50aWxfbGVkZ2VyAAAAAAAABAAAAAAAAAAC",
        "AAAABQAAACpFdmVudCBlbWl0dGVkIHdoZW4gdGhlIGNvbnRyYWN0IGlzIHBhdXNlZC4AAAAAAAAAAAAGUGF1c2VkAAAAAAABAAAABnBhdXNlZAAAAAAAAAAAAAI=",
        "AAAABQAAACxFdmVudCBlbWl0dGVkIHdoZW4gdGhlIGNvbnRyYWN0IGlzIHVucGF1c2VkLgAAAAAAAAAIVW5wYXVzZWQAAAABAAAACHVucGF1c2VkAAAAAAAAAAI=",
        "AAAABAAAAAAAAAAAAAAADVBhdXNhYmxlRXJyb3IAAAAAAAACAAAANFRoZSBvcGVyYXRpb24gZmFpbGVkIGJlY2F1c2UgdGhlIGNvbnRyYWN0IGlzIHBhdXNlZC4AAAANRW5mb3JjZWRQYXVzZQAAAAAAA+gAAAA4VGhlIG9wZXJhdGlvbiBmYWlsZWQgYmVjYXVzZSB0aGUgY29udHJhY3QgaXMgbm90IHBhdXNlZC4AAAANRXhwZWN0ZWRQYXVzZQAAAAAAA+k=" ]),
      options
    )
  }
  public readonly fromJSON = {
    pot: this.txFromJSON<Result<Pot>>,
        group: this.txFromJSON<Result<Group>>,
        pause: this.txFromJSON<Result<void>>,
        repay: this.txFromJSON<Result<void>>,
        attest: this.txFromJSON<Result<void>>,
        config: this.txFromJSON<Config>,
        paused: this.txFromJSON<boolean>,
        unpause: this.txFromJSON<Result<void>>,
        has_role: this.txFromJSON<Option<u32>>,
        limit_of: this.txFromJSON<i128>,
        pot_fund: this.txFromJSON<Result<void>>,
        pot_send: this.txFromJSON<Result<void>>,
        add_asset: this.txFromJSON<Result<void>>,
        fund_pool: this.txFromJSON<Result<void>>,
        get_admin: this.txFromJSON<Option<string>>,
        record_of: this.txFromJSON<RecordSummary>,
        advance_of: this.txFromJSON<Option<Advance>>,
        grant_role: this.txFromJSON<null>,
        pot_cancel: this.txFromJSON<Result<void>>,
        pot_create: this.txFromJSON<Result<u32>>,
        pot_release: this.txFromJSON<Result<void>>,
        revoke_role: this.txFromJSON<null>,
        group_create: this.txFromJSON<Result<u32>>,
        group_payout: this.txFromJSON<Result<void>>,
        group_record: this.txFromJSON<Result<void>>,
        pool_balance: this.txFromJSON<i128>,
        renounce_role: this.txFromJSON<null>,
        get_role_admin: this.txFromJSON<Option<string>>,
        record_advance: this.txFromJSON<Result<void>>,
        renounce_admin: this.txFromJSON<null>,
        set_role_admin: this.txFromJSON<null>,
        get_role_member: this.txFromJSON<string>,
        request_advance: this.txFromJSON<Result<void>>,
        group_contribute: this.txFromJSON<Result<void>>,
        record_repayment: this.txFromJSON<Result<void>>,
        set_credit_limit: this.txFromJSON<Result<void>>,
        get_existing_roles: this.txFromJSON<Array<string>>,
        transfer_admin_role: this.txFromJSON<null>,
        accept_admin_transfer: this.txFromJSON<null>,
        get_role_member_count: this.txFromJSON<u32>
  }
}