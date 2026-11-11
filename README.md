# Plus

A voice-first wallet that helps people the financial system left behind save, save together and borrow fairly, built on Stellar.

Built for the Stellar Blockchain Innovation Challenge, Problem Space 1: fair financial assets and affordable financing.

## Selvi's story

Selvi sells flowers in Madurai and gets a ₹1,000 monthly state transfer into her bank account, saves with neighbours in a seettu, and turns to moneylenders when an emergency hits. With Plus she talks in Tamil on WhatsApp: she hears what arrived, saves a share of it automatically, pays her seettu, and gets a small advance whose full cost is said out loud before she agrees. Every rupee stays in her bank, while Stellar quietly builds a verifiable record that she can share, by consent, to earn fairer credit.

## Funmi's story (Nigeria)

Funmi sells tomatoes at Bodija market in Ibadan and has no bank account. Her Plus wallet on Stellar is her account: she hands cash to Mama Bisi, a Plus cash agent at the market, says Yes in her app, and naira (test NGNT) lands in her wallet. She talks to Plus in Pidgin or Yoruba, pays her supplier, pays her ajo (held by the contract, paid out on time), takes a small advance with one fee said out loud (no interest, no late fees, 10% of each cash-in repays it), and cashes out with a 6-digit code. The demo ends with a switch to India: the same agent for people who do have bank accounts.

**Live:** https://plus-wallet.vercel.app (Stellar testnet, all money simulated). The front door has
one-tap demo logins for the fictional demo people; `/agent` is the cash-agent page.

## Demo

### Before every rehearsal

```sh
pnpm demo:ready
```

It resets every demo person (Nigeria and India), warms every Edge Function, then checks each
function, the cron jobs and what they answered, the chain outbox, Stellar RPC and Horizon, and a
first tap as Funmi, and prints a green **READY** or exactly what is wrong (about 30 s). Then open
**/demo** (staff login) on the projector and **/agent** (Mama Bisi) on a phone.

### The demo people

| Who | Login | What she shows |
| --- | ----- | -------------- |
| **Funmi** (Nigeria) | demo button | The unlocked borrower: no bank account, a wallet on Stellar, ₦26,400, an ajo round to pay, verified stall stock and a ₦30,000 loan offer. |
| **Kemi** (Nigeria) | demo button | New to Plus: "week 4 of 6", building her history toward a first loan, and verifying an asset from scratch (live photo, two witnesses, an inspection). |
| **Amaka** (Nigeria) | demo button | A witness: 20 weeks with Plus and a verified ID, so she can confirm Kemi's asset in her own app. |
| **Mama Bisi** (Nigeria) | /agent | The cash agent: records cash in, pays out codes, confirms and inspects assets. Float ₦200,000. |
| **Selvi** (India) | demo button | The same record for someone who does have a bank account: ₹2,350 to spend, ₹1,415 saved, a seettu. Meena is her group leader (helper page). |

### The 60-second script

| Time | On screen | Say |
| ---- | --------- | --- |
| 0:00–0:10 | Mama Bisi records ₦500 on /agent. Funmi's phone: "Mama Bisi says you gave her ₦500. Is that right?" She says "yes"; the tick, and the transaction on Stellar | "Funmi has no bank account. She hands cash to Mama Bisi, a Plus agent; nothing moves until Funmi says yes. There it is on Stellar." |
| 0:10–0:25 | Funmi: "Pay my ajo." Plus reads it back, she says yes; the ajo card's pot grows | "Her ajo's pot is held by a contract that nobody can edit or run off with." |
| 0:25–0:45 | Funmi: "Can I get a loan?" The Loan screen: you receive ₦30,000, cost ₦1,800, total ₦31,800, and why. She types her PIN; the money arrives. Then **Simulate transfer received** on Add money: 10% repays the loan by itself | "The full cost in naira before she agrees, and why she qualifies. The next money in repays a tenth of it, on its own." |
| 0:45–0:55 | Funmi: "Share my record with the lender." Her PIN, a code on her screen. On a second screen, **/verify**: type the code; her history, ajo, assets and loans, each "Read from Stellar", verified in about a second | "Any lender can check her record without trusting Plus, and never sees her name." |
| 0:55–1:00 | Kemi's phone: "week 4 of 6" | "And Kemi, two weeks from her first loan." |

### Why the blockchain is essential in Nigeria

- **The wallet is her account.** Funmi has no bank. A Stellar wallet is a real account she can
  hold, receive into and pay from, with no bank in between; Plus pays her network fees and
  reserves, so she never needs crypto of her own.
- **The ajo pot nobody can edit.** Contributions go into the Plus contract, which pays each round
  to whoever's turn it is, when it's due. No organizer can change the order, skip someone or
  disappear with the pot, and every member's tick links to the transaction.
- **A credit record she owns.** Every cash-in, ajo payment and advance repayment is on Stellar
  under her wallet address (never her name). She can show it to any lender; nobody can quietly
  rewrite it.
- **Fees small enough for small money.** Measured on testnet: a payment cost 0.00002 XLM in
  network fees and an ajo contract call about 0.001 XLM, a tiny fraction of a naira at recent XLM
  prices, so a ₦500 cash-in or a ₦1,000 ajo payment is worth sending. Plus pays them for her.

### On Stellar (testnet)

| What | Where | Holds |
| ---- | ----- | ----- |
| Her wallet | her own Stellar account (e.g. Funmi `GA6K…GW6M`) | her NGNT (and USDC); every payment, cash-in and repayment |
| `plus` contract | [`CA4VEZZO…QJP4`](https://stellar.expert/explorer/testnet/contract/CA4VEZZOSQR3RLPN2SF4FLAB5FVPLYH3C635ZSSIEJDE4ZPADGMFQJP4) | ajo pots and rounds, family pots, the advance pool, India's attestations |
| `plus_credit` contract | [`CCLO7QV3…DZCC`](https://stellar.expert/explorer/testnet/contract/CCLO7QV3LC4MPC46ZBYZDGNOVEYTY62SDRV6S4KZ7O5LVAA7RMX6DZCC) | every loan agreement (amounts, repaid, status, collateral, vouches) and every asset's level, status and verification hash, under 32-byte references only |
| `lending_ng` | partner lender's account | the loan money out and the repayments in (NGNT) |
| `anchor_ng` | partner's anchor account | bank transfers in, bank sends out (simulated partner bank) |
| `partner` | Plus's partner account | pays every fee and reserve; the only writer of `plus_credit` (with the admin) |

All IDs: [docs/deployments.md](docs/deployments.md).

**`plus_credit` (piece 8).** A second contract next to `plus` (which is unchanged). It holds no money:
the loan moves as NGNT payments, and this is the agreement and its history, so a lender can read
her record from Stellar without trusting Plus. Only partner (or the admin) can write, and every
write needs that account's signature; reads are public. It never sees a name, phone number, photo,
place, description or ID: borrowers, loans and assets are HMAC-SHA256 references (the key stays in
Vault), an asset's verification is a hash over the private evidence, and a repayment points to its
own Stellar payment hash. Statuses: Active, Late, Restructured, Repaid (only when the repayments
reach the total), Default, and Cancelled (a loan the demo reset settled: not counted as repaid).
Repaid, Default and Cancelled are final; asset levels only go up. Every change emits an event
(loan opened, repayment, status, asset registered, level, status, collateral, vouch, a vouched loan
defaulting). Postgres triggers write each change through the outbox (partner's queue); existing
loans and assets were backfilled (`select public.credit_backfill()`, safe to rerun). The app's
"Verified on Stellar" tick on a loan or an asset links to its latest `plus_credit` transaction.
21 unit tests (`cargo test -p plus_credit`) cover every function and refusal; `pnpm e2e:loan`
step 8 reads the loan, its repayments and its collateral back from Stellar.

**`/verify` (piece 9).** Public, no login. She shares her record from My record (or by voice): a
consent screen, her PIN, then a one-time code (`ABCD-EFGH`, 24 hours, one lender; she can revoke
it). The lender types it at `/verify`. Plus only turns the code into her plus_credit reference and
wallet address; the page then reads, in the lender's browser: her loans, assets and vouches from
`plus_credit`, her history and ajo payments from Horizon, and plus_credit's events from Stellar RPC.
Every line links to Stellar, and the page says how long it took (about a second). On-time ajo
payments: each within its round (no more than 1.5 rounds after her previous one into that ajo).
Saving: weeks with an ajo payment. Her history on Stellar starts when her wallet was opened; the
compressed demo weeks before that are off-chain and not shown.

### A new user: sign-up to first payment

Anyone can open a Plus account from the app's front door (`/app` → **Open a Plus account**), by
voice or by tapping. The screen shows six steps that tick off as she (or the voice agent) goes:
**name, language, phone, PIN, check it is you, wallet ready**.

- **Phone:** a 6-digit code, valid 10 minutes, 5 tries. Test numbers (`+234 700 000 0xxx`, market
  pack `onboarding.demoPhonePrefix`) show the code on screen as a simulated text message.
- **PIN:** chosen twice on the screen keypad only; weak PINs (1111, 1234) are refused. The voice
  agent cannot set or hear it.
- **Check it is you:** a photo on the screen (camera on her phone; the photo is never uploaded or
  stored; Plus keeps only "photo check passed") gives **tier 1**. Her **NIN**, typed on screen
  (never spoken), checked against a mock registry, gives **tier 2**. Plus stores only an HMAC of
  the NIN and its last 4 digits.
- **Someone she trusts** (optional): who Plus may call to help her back in.
- **Wallet:** `create_wallet` goes through the chain outbox: a new Stellar account whose reserves
  are sponsored by the partner (`begin/end sponsoring`, starting balance 0) with NGNT and USDC
  trustlines, in one transaction. The key is custodial, as for Funmi: made inside Supabase and
  stored in Vault. She gets a virtual account number at the same time. Measured: 3.1 to 6.6 s
  from Yes to "Your account is ready".
- **Agent-assisted:** Mama Bisi's `/agent` page has **Register a customer**: the same steps on her
  screen, the customer answering and typing her own PIN and NIN. **A kiosk works the same way**:
  the agent flow on a shared tablet, with the agent's login replaced by the kiosk's.
- **Returning users:** **I have an account** → phone number + PIN (the PIN lockout applies).
- Re-running sign-up with a test number is safe: the earlier test person is archived (login
  disabled, history kept) and the number is free again. A real number that already has an
  account is refused.

**Tiers** (market pack `kyc.tiers`, modelled on Nigeria's tiered KYC; the partner sets the real
limits). Every money tool enforces them: pay, pay by code, ajo, cash out, advances, cash-in and
bank transfers in (her balance limit).

| Tier | Needs | Send per day | Hold | Advances |
| ---- | ----- | ------------ | ---- | -------- |
| 1 | name, phone, photo | ₦50,000 | ₦300,000 | no |
| 2 | + NIN | ₦200,000 | ₦500,000 | after 8 weeks as a member |

India uses the same flow with ₹5,000 / ₹10,000 (tier 1) and ₹10,000 / ₹2,00,000 (tier 2). There
is no ID step in the app: the partner bank does KYC, and Plus never asks for Aadhaar.

**Money in.** *Bank transfer:* each wallet has a 10-digit virtual account number at "Partner bank
(simulated)". **Add money** shows it with a copy button; the demo button **Simulate transfer
received** makes the partner's anchor account (`anchor_ng`, funded by the issuer) send the NGNT to
her wallet through the outbox. It shows in `what_arrived` as "a bank transfer from …", and 10% goes
to an open advance. *Cash with an agent* is unchanged. *From another Plus user:* see below.

**Pay anyone by phone.** If the number is a Plus user, an NGNT payment wallet to wallet (it shows
in their "what arrived"). If not, a claimable balance that any Plus agent can claim, with a code
sent by text (simulated on her screen); the person collects the cash with the code and their phone
number. Same read-back, Yes and PIN pad. Afterwards she can **Save this person**.

### What is simulated

- Testnet only: no real money moves. **NGNT** is a test naira asset issued by Plus; in production
  it would be naira from a licensed e-money or stablecoin partner.
- Mama Bisi, Funmi, Iya Tunde, Amaka and the ajo members are fictional; their phone numbers are
  fake. The cash Mama Bisi "receives" is pretend.
- NIN checks (a mock registry: any 11 digits pass except `00000000000`), the photo check (a pass
  flag only), text messages (codes shown on screen), the partner bank behind the virtual account
  numbers and its anchor account; in India the partner bank, UPI and KYC (`payout-sim`,
  `partner_kyc_mock`). No real company names or logos are used.
- `/verify`: lenders are not checked or registered; any holder of a code can open it once.
  Testnet only: the "months of history" are days for the demo people.
- Send to a bank account (Nigeria): the banks (Ironwood, Harmattan, Lagoon Trust, Kolanut, Savanna
  Microfinance, Market Women's Cooperative) and the account-name lookup are fictional. Her NGNT really
  moves on Stellar to the partner's anchor account (`anchor_ng`) as a withdrawal, and the anchor's record
  keeps the account (`bank_withdrawals`); the payout to the bank is simulated. In production this is a
  SEP-24/SEP-6 withdrawal with a memo and the bank's real name enquiry. Ironwood Bank `0123456789` is
  ADEBAYO STORES (Funmi's saved "Landlord"); `0000000000` and numbers starting `999` are "not found".
- Custodial keys sit in Supabase secrets (demo people) or Vault (new sign-ups, `anchor_ng`); in
  production they would be in a KMS/HSM or held by the user (passkeys).
- Demo people (Funmi, Kemi, Amaka, Selvi, Mama Bisi, Meena) sign in with a demo password; new users sign up with a
  phone code and sign in with phone + PIN.
- Loans: the partner lender and its lending account (`lending_ng`, NGNT on testnet) are simulated;
  the numbers (ladder, cost, repayment) are illustrative and live in the market pack. Her weeks
  before Plus recorded them are a **compressed demo history** (`credit_history_seed`: weekly
  summaries topped up by `pnpm demo:reset ng`); everything after is read from her real
  transactions. Kemi (new to Plus, "week 4 of 6") is a real sign-up on a test number whose start
  date the reset moves back 23 days. The old 1.5% advance is retired from the app; its contract
  functions stay.
- Assets (Nigeria): off-chain. A live photo goes to a private Storage bucket; Postgres keeps only
  its sha-256, the time and a place rounded to about 1 km. Witnesses (two eligible Plus users or an
  agent) and the inspection are recorded in Postgres; the confidence score is for lenders and is
  never selectable by the app. Amaka's 20 weeks with Plus and verified ID are set by the reset.
- Ajo rounds are 1 day (real ajo: weekly or monthly); Funmi's 8 weeks of history were run with
  1-minute rounds.
- `pnpm demo:reset` tops up or sweeps balances through the test issuer between rehearsals (these
  show in her record as "demo reset (testnet)").
- Voice for Nigeria shows "Voice coming soon" until `ELEVENLABS_AGENT_ID_NG` is set
  (`agent/ng/README.md`).

### Measured (testnet, 2026-11-10)

| What | Time |
| ---- | ---- |
| Her Yes → tick (confirmed on-chain), `pnpm e2e:ng`, 8 transactions | median 4.8 s, max 7.6 s (a busier testnet hour: median 6.5 s) |
| Contract call, Yes → confirmed, before / after the speed work | median 10.6 s → 4.6 s |
| First confirm of the day: cold function / after `pnpm warm` | 7.5 s → 0.8 s |
| First tap on **Simulate transfer received** after `pnpm warm` (deep warm-up of agent-tools) | 1.15 s → 0.32–0.40 s |
| `pnpm demo:ready` (both resets, warm-up, all checks) / `pnpm demo:reset ng` / `in` | about 30 s / 20 s / 2 s |
| Edge Function `/health`: cold / warm | 0.5–1.2 s / 0.06–0.1 s |
| Balance read from Horizon (Edge Function) | about 0.15 s |
| Sign-up, `pnpm e2e:ng --new-user` (2026-11-09): 11 steps, server time | 3.9 to 4.7 s |
| New wallet (sponsored account + NGNT/USDC trustlines): Yes → ready | 3.8 s, 6.6 s |
| Bank transfer in ₦5,000: button → tick | 3.4 s, 4.2 s |
| First payment ₦500 to a Plus user by phone | 4.3 s, 5.0 s |
| Pay by code ₦300 / agent pays it out | 4.0–4.6 s / 3.1–3.8 s |
| Sign-up to first payment, all of it | 28 to 31 s |
| Send ₦2,000 to a bank account (`pnpm e2e:bank`): Yes → on Stellar to the partner's anchor | 8.4 s |

### Demo tools

- `pnpm demo:ready`: the reset for both markets, the warm-up and the checks (above). `--check`
  checks only; `ng` or `in` for one market.
- `pnpm demo:reset ng`: every Nigeria demo person back to a fixed start. Funmi: ₦26,400, no loan
  open (an open one is settled by the reset, which doesn't count toward her ladder) and the ₦30,000
  offer, stall stock independently verified, an ajo round she hasn't paid (a new round with the
  same members if she has), her landlord's bank account saved as "Landlord". Kemi: week 4 of 6, no assets (earlier ones are released). Amaka: able
  to witness, Kemi's saved payee. Nothing waiting anywhere: no pending actions, cash-ins, unused
  cash-out codes or witness requests for Funmi, Kemi, Amaka or Mama Bisi; Mama Bisi's float
  ₦200,000. `pnpm demo:reset in`: Selvi at ₹2,350 to spend and ₹1,415 saved, no advance, seettu
  unpaid this round, nothing waiting for her or Meena. Never deletes anything; it only adds
  transactions. Prints the state the app shows and how long it took.
- `pnpm warm`: wakes every Edge Function (`GET /functions/v1/<fn>/health` with the agent secret),
  then `agent-tools/warm` opens its database and Stellar RPC connections so a first tap answers in
  under a second. To keep them warm for a whole session, set the Supabase secret `DEMO_WARM=true`:
  the `plus-warm` cron then does the same every 5 minutes (remove it afterwards to stop).
- **/demo** (staff login from `pnpm staff:create`): the projector view. Left, the app in a phone
  frame signed in as Funmi (`/app?as=funmi`); right, every Stellar transaction behind it (Funmi,
  Mama Bisi, the ajo pot, the advance pool) with the seconds from her Yes and a Stellar Expert
  link; top, the Nigeria / India switch.
- `pnpm demo:new-user`: a fresh test person for rehearsals through the real sign-up (next free
  test number, tier 2, wallet on Stellar; `--tier 1`, `--name`, `--fund 5000`, `--free` to only
  print the next free number for a live sign-up). Prints the phone, a test PIN, the account number
  and the Stellar Expert links.
- **Public demo logins.** The front door's demo buttons share one password
  (`VITE_DEMO_LOGIN_PASSWORD`, in the public bundle on purpose) that only opens the named demo
  people: Funmi, Kemi, Amaka, Selvi, Mama Bisi and Meena. Staff (/demo), partner and admin logins keep
  their own passwords. `pnpm demo:logins` sets it (and flags those rows). The backend checks the
  Supabase secret `DEMO_LOGINS_ENABLED`; after the showcase, switch them off in one command:
  `npx supabase secrets set DEMO_LOGINS_ENABLED=false --project-ref qoqmnjzfjhpemwleipth`.
  Money actions by a demo person are rate-limited (15 per 10 minutes, 120 a day). Run
  `pnpm demo:ready` before every rehearsal.
- **Deploys.** Vercel project `plus-wallet` (root `apps/web`) redeploys on every merge to `main`;
  pull requests get preview URLs (allowed by the Edge Function CORS list).
- `pnpm screens` (`--dark` for dark mode): phone-size screenshots of every screen into `docs/screens/` (headless Chrome,
  no extra installs; needs `pnpm --filter web dev --port 5199`).

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
├── contracts/plus/        Soroban contract (Rust): pots, ajo, advance pool, attestations
├── contracts/plus_credit/ Soroban contract (Rust): loans, assets and vouches (piece 8)
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

## The Plus app

`pnpm --filter web dev`, then:

- **http://localhost:5173/app**: the Plus app, Selvi's home. Mobile-first PWA (installable; manifest, icons, a service worker that never caches money data). Tamil labels with English underneath, a Tamil/English toggle, nothing smaller than 16px, and the big mic **பேசுங்க** on every screen. Screens: Home, Pay, Seettu, Advance, My record, Add money, Settings.
- **Front door:** `/app` signed out shows **Open a Plus account** (sign-up, see "A new user" above), **I have an account** (phone + PIN) and the demo people.
- **Funmi (Nigeria):** on `/app`, "Continue as Funmi". The app picks its screens from the Nigeria market pack (`getMarket('ng').screens`): Home, Add money (bank transfer or agent cash), Pay (saved people or any phone number), Ajo, Advance, Cash out, My record, Settings, with English and Yoruba labels. After her Yes the confirm sheet shows "Sending on Stellar…", then the tick, the seconds it took and the Stellar Expert link. Balances come from `wallet_balances`, refreshed from Horizon after every confirmed transaction and every minute.
- **http://localhost:5173/agent**: the cash agent page, Mama Bisi ("Continue as Mama Bisi"). **Register a customer** (the sign-up on her screen), record cash (customer phone + amount; checks her float and the ₦500,000 daily limit; Funmi then gets "Mama Bisi says you gave her ₦500. Is that right?"; 10% goes to an open advance) and redeem a cash-out code (shows the amount, then claims the cash-out on Stellar). Own login, so it can sit next to `/app`.
- **http://localhost:5173/helper**: the helper page, where Meena records cash a member handed her. It keeps its own login, so both pages can be open side by side.

**Design system.** Calm and minimal, in the spirit of a modern wallet app. One tokens file, `apps/web/src/ds/tokens.css`, holds every colour, type size, radius and shadow:
- near-white and near-black with soft greys;
- one accent per market (Nigeria deep green, India deep indigo);
- full dark mode that follows the phone;
- Inter with tabular, light numerals for money;
- body text 17px, nothing under 13px.

The core components are in `apps/web/src/ds/` and every screen uses them:
- Card, CardStack and Pass: Home is a stack of passes that open full-screen and close with a swipe down.
- Sheet, ConfirmSheet, AmountDisplay, ListRow, PinPad and NumPad.
- Tick, EmptyState and VerifiedMark: the only chain word users see is "Verified on Stellar".
- The floating mic (`plus/voice.tsx`), with a live waveform and the conversation as text.

Lucide line icons; gentle springs (motion), off with reduce motion. Screenshots in light and dark: `docs/screens/`.

**Logins.** The demo uses two Supabase Auth users created by `pnpm seed:db`: "Continue as Selvi" (`demo-selvi@example.com`) and "Continue as Meena" (`demo-meena@example.com`), password generated into `VITE_DEMO_LOGIN_PASSWORD` in the root `.env.local`. They are linked through `users.auth_user_id` and `helpers.auth_user_id`. **Production login is phone OTP plus a PIN**, not these demo buttons.

**One code path.** Taps and voice call the same `agent-tools` functions. Money always moves in two steps: a `prepare_*` tool creates a pending action, the confirm screen opens by itself (Realtime on her own `pending_actions`, `transactions` and `cash_events`, filtered by RLS), and she taps Yes or says yes, up to ₹500 / ₦5,000; above that she types her PIN on the screen's PIN pad. The PIN goes from the app straight to `agent-tools`; it never passes through the voice agent. A cash-in from a helper only counts after her Yes.

**Everything by voice.** Every screen action is also a voice tool in both agents. `help` ("what can I do?") is a webhook; `navigate(screen)`, `what_is_on_screen` and the screen buttons (demo money in, a new cash-out code, language, trusted person, sign out) are ElevenLabs client tools that run in her browser with her own login (`apps/web/src/plus/screen.ts`). Each screen describes itself in a sentence (`useSays`), and the mic sends that to the agent whenever it changes, so the agent can always say what is on her screen. The PIN is the one exception: set and typed on the screen only.

**Voice.** The mic calls `voice-session` (checks her login, gets a signed URL for the private ElevenLabs agent, mints a 15-minute `plus_session` token) and starts the official React SDK with `plus_session` as a dynamic variable. Setup steps: `agent/tools/README.md` (India) and `agent/ng/README.md` (the "Plus Nigeria" agent; `voice-session` picks the agent by the user's market).

### Background jobs (Supabase Cron, one-time setup)

`chain-worker` (writes the `chain_outbox` to Stellar, one transaction at a time per signer), `sync-events` and `scheduler` run every minute, and `expire_stale_actions` every 5 minutes. `scheduler` refreshes Nigeria wallet balances, pays an ajo round on the contract when it is due (`group_payout`), expires agent cash-ins after 24 hours and returns cash-outs nobody redeemed in 7 days. Cron and the after-insert kick read two Vault secrets. Create them once in the SQL editor of the dev project (the second value is generated inside the database and never shown):

```sql
select vault.create_secret('https://qoqmnjzfjhpemwleipth.supabase.co/functions/v1', 'plus_functions_url');
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'plus_cron_secret');
```

Until they exist, the jobs log a notice and do nothing; the functions still kick `chain-worker` after each confirm.

### Testnet RPC

Each attest takes about 10 to 15 seconds on the public `https://soroban-testnet.stellar.org`. If it stays slow, free testnet RPC providers listed in the Stellar docs (RPC providers page) include Validation Cloud, QuickNode, Blockdaemon, Ankr and NOWNodes. Most need a free account; we have not signed up for any. Switch by setting `STELLAR_RPC_URL`.

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
- `pnpm e2e` (by hand, not CI): runs the India flow against the dev project by voice session and app: state transfer, auto-save, what arrived, pay the flower wholesaler ₹300, seettu, helper cash-in confirmed, my record. Then waits for the chain outbox and checks each contract event on Stellar, printing confirm → on-chain times.
- `pnpm e2e:ng` (by hand, not CI): the Nigeria demo through the real functions: Mama Bisi records ₦500 and Funmi says Yes, pay Iya Tunde, ajo, advance (and auto-repay from a cash-in), cash-out code redeemed by the agent, my record. Prints Yes → tick seconds and a Stellar Expert link per step. `pnpm e2e:ng --read` only reads (balances, ajo, advance, record, agent float). Step 8 (also alone with `pnpm e2e:ng --new-user`): a new person on test number +234 700 000 0301 from sign-up to first payment: a wrong NIN refused, the wallet opened, a bank transfer in, ₦500 to Funmi by phone, ₦300 by code to someone not on Plus that Mama Bisi pays out, the tier limit refusing ₦250,000, and signing in again with phone + PIN.
- `pnpm e2e:assets` (by hand, not CI; run `pnpm demo:reset ng` first): a test person on +234 700 000 0303 registers a sewing machine, takes the live photo, asks Amaka and Mama Bisi, both confirm, Mama Bisi inspects it; checks that only the hash and a rounded place are stored, the photo is private, the confidence score never reaches her, and stolen/found statuses. 22 checks.
- `pnpm e2e:loan` step 8: after the loan flow, reads the agreement, both repayments and the pledged stall stock back from `plus_credit` on Stellar (stellar CLI, `admin` identity), checks nothing personal went on-chain, then "Repay all" closes it there as Repaid and frees the stall stock.
- `pnpm e2e:verify` (by hand, not CI): a test person on +234 700 000 0304 with a verified stall stock takes a loan and repays ₦2,000; shares her record (consent, PIN, code; the code is stored nowhere, only its keyed hash); a lender's anonymous lookup returns only her reference and wallet, and plus_credit on Stellar shows the loan, the repayment and the stall stock; a wrong code is refused, every view logged, revoking stops the code. `--keep` prints one more open code to try `/verify` by hand.
- `pnpm e2e:bank` (by hand, not CI; run `pnpm demo:reset ng` afterwards): as Funmi, the name lookup (Ironwood Bank 0123456789 → ADEBAYO STORES, a 999… number refused), ₦2,000 to the account (her Yes is enough; a retried Yes sends nothing twice), NGNT on Stellar to `anchor_ng` and the anchor's withdrawal record, "sent to bank (partner, simulated)" in her record, and ₦8,000 refused without her PIN.

### Secrets (Supabase secrets, never committed)

`PLUS_CONTRACT_ID`, `NGNT_SAC_ID`, `USDC_SAC_ID`, `PARTNER_SECRET` (pays fees, sponsors reserves), the `STELLAR_SECRET_*` custodial keys named by `users.secret_name` (Nigeria: `STELLAR_SECRET_FUNMI`, `STELLAR_SECRET_AGENT_NG`), `CASHOUT_CODE_SECRET` (cash-out code hashes), `AGENT_SHARED_SECRET`, `USER_REF_SECRET`, `PIN_PEPPER`, `VOICE_SESSION_SECRET`, `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_AGENT_ID_NG`, and optionally `DEMO_WARM` (`true` keeps the functions warm). Names are in `.env.example`; values live only in Supabase secrets and Vault.
- `pnpm demo:ready`, `pnpm demo:reset ng|in` and `pnpm warm`: see "Demo" above.
- `pnpm bindings`: regenerates `packages/plus-client` from the deployed contract and re-applies the `@plus/client` name and the TypeScript 7 `rootDir` fix.
