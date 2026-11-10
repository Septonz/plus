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

export interface ContractReader {
  group(onchainId: number): Promise<ChainGroup | null>;
  advanceOf(pub: string): Promise<ChainAdvance | null>;
  limitOf(pub: string): Promise<bigint>;
  poolBalance(assetSac: string): Promise<bigint>;
}
