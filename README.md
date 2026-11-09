# Plus

A voice-first wallet that helps people the financial system left behind save, save together and borrow fairly, built on Stellar.

Built for the Stellar Blockchain Innovation Challenge, Problem Space 1: fair financial assets and affordable financing.

## Selvi's story

Selvi sells flowers in Madurai and gets a ₹1,000 monthly state transfer into her bank account, saves with neighbours in a seettu, and turns to moneylenders when an emergency hits. With Plus she talks in Tamil on WhatsApp: she hears what arrived, saves a share of it automatically, pays her seettu, and gets a small advance whose full cost is said out loud before she agrees. Every rupee stays in her bank, while Stellar quietly builds a verifiable record that she can share, by consent, to earn fairer credit.

## Market packs

Plus is one shared core plus a **market pack** per country (`packages/markets`). A pack sets the currency, languages, custody model, payment rail, cash-out method, group-savings style, advance limits and ID check.

- **India (primary):** rupees in a partner bank (simulated), UPI (simulated), Tamil and English, seettu recorded on Stellar. Users never hold crypto.
- **Nigeria (second pack):** naira as a Stellar test asset (NGNT) plus optional USDC on the user's own account, pooled ajo held by the contract.

See [docs/markets.md](docs/markets.md).

## Folder map

```text
.
├── apps/web/              Vite + React + Tailwind web app
├── packages/markets/      Market packs (source of truth, TypeScript, no deps)
├── packages/plus-client/  Generated contract bindings (@plus/client, `pnpm bindings`)
├── contracts/plus/        Soroban contract (Rust)
├── supabase/
│   ├── config.toml
│   ├── migrations/        One migration per table (applied through the Supabase MCP server)
│   ├── tests/             SQL tests (money functions)
│   └── functions/
│       ├── _shared/       auth.ts, caller.ts, pin.ts, stellar.ts (+ stellar-retry.ts), user_ref.ts, markets.ts (generated)
│       ├── agent-tools/   Voice agent tool endpoint (shared-secret auth)
│       ├── payout-sim/    Simulated bank / UPI payouts
│       ├── sender-api/    Family abroad (SEP-31, family pots)
│       ├── sync-events/   Contract events -> Postgres
│       └── scheduler/     Periodic jobs
├── agent/                 Voice agent prompts (in/, ng/) and ElevenLabs tool definitions (tools/, see tools/README.md)
├── scripts/               sync-markets.mjs, seed.ts, seed-db.ts, create-staff.ts, bindings.mjs, spikes/ (throwaway reference code)
├── docs/                  deployments.md, markets.md, spikes/ (spike write-ups)
├── Cargo.toml             Rust workspace
└── package.json           pnpm workspace
```

## Setup

Prerequisites: Git, Node 20+, pnpm (version pinned in `package.json`), Rust with the `wasm32v1-none` target, Stellar CLI, Deno, GitHub CLI (optional). Docker is not needed.

### Windows (PowerShell)

```powershell
winget install Git.Git OpenJS.NodeJS.LTS Rustlang.Rustup DenoLand.Deno GitHub.cli
corepack enable
rustup target add wasm32v1-none
cargo install --locked stellar-cli
git clone <repo-url> plus; cd plus
pnpm install
Copy-Item .env.example apps\web\.env.local   # then fill in the VITE_* values
pnpm markets:check; pnpm build; cargo test; stellar contract build
pnpm --filter web dev
```

### macOS (zsh)

```sh
brew install git node rustup deno gh stellar-cli
rustup-init -y && rustup target add wasm32v1-none
corepack enable
git clone <repo-url> plus && cd plus
pnpm install
cp .env.example apps/web/.env.local   # then fill in the VITE_* values
pnpm markets:check && pnpm build && cargo test && stellar contract build
pnpm --filter web dev
```

### Supabase (both)

```sh
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
npx supabase secrets set AGENT_SHARED_SECRET=<random-string>
npx supabase functions deploy
```

Edit market packs in `packages/markets/src/markets.ts`, then run `pnpm markets:sync`. Never edit `supabase/functions/_shared/markets.ts`.

### Contract bindings

Regenerate the TypeScript client with `pnpm bindings` (never edit `packages/plus-client` by hand). It currently wraps `stellar contract bindings typescript`, which stellar-cli 30 marks as **deprecated** in favour of the JavaScript Stellar SDK's own generator:

```sh
npx @stellar/stellar-sdk generate --network testnet --contract-id <CONTRACT_ID> --output-dir packages/plus-client --overwrite
```

The old command still works, so we have not switched yet. When we do, change only `scripts/bindings.mjs` (it keeps re-applying the `@plus/client` name and the `rootDir` fix). Pass the contract ID from `docs/deployments.md`; the stellar CLI alias `plus` is CLI config that the SDK generator is not expected to read.

## Prototype simplifications

This is a Testnet prototype. Where it cuts corners, it does so in ways that do not carry over to production:

- **Demo user refs are public.** The seeded Indian users (Selvi and her neighbours) use `user_ref = sha256("plus-demo:<name>")`. Anyone can recompute those, which is fine for fictional demo people only.
- **Real users get keyed refs.** A real user's `user_ref` is `HMAC-SHA256(USER_REF_SECRET, phone number in E.164)`, computed server-side by `userRef(phone)` in `supabase/functions/_shared/user_ref.ts`. Without the server secret, nobody can link an on-chain hash to a person or brute-force phone numbers against it. The phone number and the secret never go on-chain or into logs. `USER_REF_SECRET` lives only in Supabase secrets (`npx supabase secrets set USER_REF_SECRET=<random 32 bytes>`); rotating it changes every ref, so treat it as permanent.
- **Testnet only.** Accounts, assets (test NGNT, Circle testnet USDC) and the contract are on Stellar Testnet; see `docs/deployments.md`. `pnpm seed` refuses any other network, and `pnpm seed --fresh` redeploys the contract before reseeding.
- **Bank, UPI and KYC are simulated** (`payout-sim`, `partner_kyc_mock`, `nin_mock`). Simulated bank balances (`sim_bank_accounts`) change only through the `sim_*` Postgres functions, which are atomic and idempotent on `ref`.
- **PINs** live in `user_credentials` (RLS on, no policies): `HMAC-SHA256(PIN_PEPPER, salt || pin)`, locked for 15 minutes after 3 wrong tries (`supabase/functions/_shared/pin.ts`).
- **Caller identity** for the voice agent is ElevenLabs' `system__caller_id` (phone number on calls, WhatsApp user ID on WhatsApp), checked against `users.wa_phone`. Caller ID can be spoofed on phone calls, so money actions also need a PIN above the market's threshold.

### Scripts

- `pnpm seed`: re-runnable Testnet demo data (state in `scripts/.seed-state.json`). `pnpm seed --fresh` redeploys `plus`, regenerates bindings, updates the `PLUS_CONTRACT_ID` secret and `apps/web/.env.local`, then reseeds.
- `pnpm seed:db`: re-runnable demo rows in the dev Supabase project. Needs `DEMO_SELVI_PHONE` (your WhatsApp number, so you can play Selvi). Balances are built only through `sim_credit` / `sim_debit` / `sim_move_to_savings` with fixed refs, so reruns never apply money twice.
- `pnpm staff:create`: creates the staff dashboard user (`DEMO_STAFF_EMAIL`) with `app_metadata.role = staff`, and prints how to log in.
- `pnpm test:functions`: Deno tests for `supabase/functions/_shared` (PINs, caller ids). SQL tests for the money functions are in `supabase/tests/` (run in a rolled-back transaction).
- `pnpm bindings`: regenerates `packages/plus-client` from the deployed contract and re-applies the `@plus/client` name and the TypeScript 7 `rootDir` fix.
