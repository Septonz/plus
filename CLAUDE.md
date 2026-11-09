# Plus: rules for Claude

Plus is a voice-first wallet on Stellar. See README.md for the folder map and AGENTS.md for Soroban build/test commands.

## Secrets
- Never commit secrets. Keys live only in Supabase secrets or Vault. .env files are never committed, only .env.example.
- The Supabase MCP server is for the dev project only.

## Soroban
- Use `#[contractevent]`, not `env.events().publish`.
- Return `Result` with a `#[contracterror]` enum instead of panicking.
- `require_auth` on anything that moves money.
- `extend_ttl` on persistent writes.

## Privacy
- Never put personal data on-chain; use 32-byte hashes only.
- Indian users never hold crypto.
- Never collect or store Aadhaar numbers.

## Money
- Money is always integers: i128 with 7 decimals on-chain, bigint minor units (paise, kobo) in Postgres. Never floats.
- Every money action is prepare then confirm. `confirm_action` must be idempotent: claim the pending action with one atomic update and return the stored result on retries.
- Save the transaction hash before polling and never resubmit blindly. Submit through one queue per signing account.
- The contract never holds everyday user balances, only group pots, family pots and the advance pool.

## Markets
- Edit `packages/markets` and then run `pnpm markets:sync`; never edit the `_shared` copy.
- India is the primary market: finish India features before Nigeria ones.

## Workflow
- Small commits on feature branches.
