// Shared Stellar helpers for Edge Functions. Keep the SDK version pinned.
import * as StellarSdk from "npm:@stellar/stellar-sdk@17.4.0";

export { StellarSdk };

// Network retry (network errors only) and safe submission (look up by hash before
// any resend). Dependency-free so Node scripts can share it.
export {
  isNetworkError,
  OutcomeUnknownError,
  pollTransaction,
  submitTransaction,
  SubmitRejectedError,
  txHashHex,
  withRetry,
} from "./stellar-retry.ts";
export type { RetryOptions, SubmitOptions } from "./stellar-retry.ts";
