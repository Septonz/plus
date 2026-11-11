// Contract state as Plus Nigeria reads it (views of the Plus contract), in minor units.
// Dependency-free so tools and tests can use it without the Stellar SDK or supabase-js.

export interface ChainGroup {
  members: string[]; // G... addresses ("" for a Ref member)
  amount_minor: bigint;
  period_secs: number;
  next_due: Date;
  turn: number;
  pot_minor: bigint;
  pooled: boolean;
  contributed: boolean[];
}

export interface ChainAdvance {
  principal_minor: bigint;
  fee_minor: bigint;
  owed_minor: bigint;
  opened_at: Date;
}

/** A pot on the plus contract (piece 11: her savings goal is one, paying back to herself). */
export interface ChainPot {
  sender: string;
  payout_to: string;
  balance_minor: bigint;
  per_period_minor: bigint;
  period_secs: number;
}

export interface ContractReader {
  group(onchainId: number): Promise<ChainGroup | null>;
  advanceOf(pub: string): Promise<ChainAdvance | null>;
  limitOf(pub: string): Promise<bigint>;
  poolBalance(assetSac: string): Promise<bigint>;
  pot(potId: number): Promise<ChainPot | null>;
}
