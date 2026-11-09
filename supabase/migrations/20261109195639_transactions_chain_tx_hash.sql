-- transactions.chain_tx_hash: hash of the Stellar transaction that put this entry on the
-- user's on-chain record (attest or group_record). Set by chain-worker once it succeeds.
alter table public.transactions
  add column chain_tx_hash text check (chain_tx_hash ~ '^[0-9a-f]{64}$');
