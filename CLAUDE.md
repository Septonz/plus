# Plus: rules for Claude

Plus is a voice-first wallet on Stellar. See README.md for the folder map and AGENTS.md for Soroban build/test commands.

## Secrets
- Never commit secrets. Keys live only in Supabase secrets or Vault. .env files are never committed, only .env.example.
- The Supabase MCP server is for the dev project only.

## Edge Functions
- `verify_jwt` for every function is set explicitly in `supabase/config.toml`, and `pnpm functions:check-jwt` (CI) holds it to an approved list. Never change that list without the owner's approval.
- Why: `supabase functions deploy` applies config.toml. On 2026-11-10 a full deploy turned the gateway JWT check on for scheduler and sync-events, and pg_cron (which sends only `x-plus-cron-secret`, no JWT) got 401s for 45 minutes.
- Approved `verify_jwt = false`: agent-tools, scheduler, sync-events, chain-worker, agent-api, helper-api, voice-session, payout-sim (added 2026-11-10 so `pnpm warm` reaches it). Each checks its own secret or login as the first step of every route: `jobGate` (`_shared/cron.ts`) for the cron functions, the login check for the rest; payout-sim's `/health` takes the cron or agent secret (`privateHealth`). `job-gate.test.ts` and `login-gate.test.ts` prove it; keep them passing when adding a route.

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
