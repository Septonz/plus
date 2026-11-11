# Roadmap

The plan for pieces 3 to 10, saved so it survives new sessions. Tick an item (`[x]`) when it is
merged to main.

How we build: in this order, each piece on its own branch, using the design components in
`apps/web/src/ds/`. Merge to main when CI is green, so the live site
(https://plus-wallet.vercel.app) updates, and report what to try there after each one. Follow
CLAUDE.md. All money is simulated on Testnet.

## Piece 3: Everything by voice

- [x] Every screen action is also a voice tool, in both agents (update them with `pnpm agents:sync`).
- [x] A voice "yes" confirms money moves up to ₦5,000 / ₹500; above that, the PIN pad on screen.
- [x] New tools: `help` ("what can I do?") and `navigate(screen)`. The agent always says what's on screen.

## Piece 4: Lending model

Two demo users (naira, illustrative numbers), both with demo login buttons.

- [x] **Kemi** (new user, week 4 of 6): can save, transact, register and verify assets (asset flows: piece 5). She sees
  "Building your Plus history, week 4 of 6" with a checklist: identity verified, qualifying
  transactions, active weeks, one verified asset, and 2 more weeks needed. Also an estimated future
  range marked "estimate, not an offer". Never the words "rejected" or "not eligible". New sign-ups
  land in this view at week 1 of 6.
- [x] **Unlock rules:** account open 6+ weeks, money in during at least 4 of them, a minimum number
  of qualifying transactions, verified identity, good standing. Circular or back-and-forth
  transfers don't count.
- [x] **Funmi** (unlocked, 8+ weeks, verified stall stock): a loan offer showing why she got it
  (activity 40%, verified assets 35%, savings consistency 25%), written as "you receive ₦30,000,
  cost ₦1,800, total ₦31,800". Repayment: 10% of every money-in plus a minimum of ₦2,500 every two
  weeks.
- [x] **Rewards ladder**, shown before she accepts: next loan ₦50,000 at 5%, then ₦80,000 at 4.5%;
  collateral 150% → 125% → 100% → partial; faster approval.
- [x] **Affordability first:** stall stock estimated ₦90,000, lending value ₦54,000, affordable
  limit ₦30,000, so the lower one wins.
- [x] **Accepting needs the PIN pad.** Funds go as NGNT from a partner lending account to Funmi
  through the outbox (real Testnet), with loan state in the database. Repayments (10% of each
  money-in, and the two-weekly minimum from the scheduler) go as NGNT back to the lending account.
- [x] **Repay screen** with "I need more time", which offers a short extension and pauses new
  borrowing. Missed payment path: reminder, grace period, restructure, borrowing frozen; never
  contact anyone else.
- [x] Retire the old 1.5% advance from the UI but keep its contract functions.

## Piece 5: Assets, from day one, for any user

- [x] Register by voice or tap: type (stock, tools, machine, motorcycle, livestock), description,
  estimated value.
- [x] **Verification levels:** Registered → Evidence verified (live photo, which voice can trigger
  with "take the photo", plus timestamp and approximate location; photo stored privately, only a
  hash in the DB) → Community verified (two eligible witnesses confirm; eligible = verified ID,
  account older than 6 weeks, good standing; Mama Bisi and Amaka can confirm from /agent) →
  Independently verified (agent inspection from /agent).
- [x] **Statuses:** Active, Under review, Lost, Stolen, Damaged, Released.
- [x] Customers see the level; an internal confidence score is kept for lenders. Funmi's stall
  stock is seeded as Independently verified.
- Done 2026-11-10: `pnpm e2e:assets` (22 checks) passes on the dev project. Nigeria UI only for now;
  Amaka witnesses in her own app (demo login), Mama Bisi under Assets on /agent.

## Piece 6: Demo reset and README

- [x] `pnpm demo:reset ng` resets Kemi and Funmi to their starting states (Funmi: no loan open,
  offer available; Kemi: week 4 of 6).
- [x] README: both demo users, a 60-second demo script, and a plain list of what's simulated.
- [x] `pnpm warm` reaches every function, including payout-sim: payout-sim's `/health` gets the same
  cron-secret check (or staff login) as the others instead of the gateway JWT. Update the approved
  `verify_jwt` list and its CI check (`pnpm functions:check-jwt`) to match (approved 2026-11-10).
  Confirm a warmed first click on "simulate transfer received" responds in under 1 second.
- [x] `pnpm demo:ready`: both resets, the warm-up, then every function, the cron jobs (and what
  their calls answered), the chain outbox, Stellar RPC and Horizon, and a first tap; prints READY
  or what's wrong.
- Done 2026-11-10: demo:ready READY in 26 s (reset ng 20 s, in 2 s). A warmed first "simulate
  transfer received" answers in 0.32-0.40 s (was 1.15 s): agent-tools/warm now opens its database and
  Stellar RPC connections. payout-sim /health takes the cron or agent secret; verify_jwt off for it.
  No open shares to clear yet (they arrive with piece 9).

## Piece 7: Send to a bank account (Nigeria)

- [ ] On Pay: a 10-digit account number and a bank from a generic list. A simulated account-name
  lookup ("Account name: ADEBAYO STORES") is shown before she confirms.
- [ ] On confirm, NGNT goes from her wallet to `anchor_ng` through the outbox, as an anchor
  withdrawal, shown as "Sent to bank (partner, simulated)" with the Stellar tick.
- [ ] Voice: "Send ₦8,000 to my landlord's bank account". Same confirm rules. No real bank or
  company names except a generic bank list.

## Piece 8 (Wednesday, after the rest): `plus_credit` contract

- [ ] A `plus_credit` Soroban contract, deployed alongside the existing one. It holds each loan
  agreement (borrower ref, lender, principal, cost, total, repaid, repayment %, minimum, collateral
  ref, status: Active, Late, Restructured, Repaid, Default) and each asset's reference (anonymous
  asset ID, verification hash, level, collateral status). No personal data on-chain.
- [ ] The backend writes to it through the outbox at every loan and asset change, and the app's
  small "Verified on Stellar" tick links to it.

## Piece 9 (after piece 8; reads from `plus_credit`): Verify a Plus record, the key demo moment

- [ ] Funmi can say "share my record with the lender" or tap Share on My record: consent screen,
  PIN, then a one-time 8-character code valid for 24 hours. Every share is logged and can be
  revoked.
- [ ] A public page `/verify` (no login): a lender enters the code and sees, read directly from
  Stellar (`plus_credit` contract and contract events), an anonymous summary: months of history,
  ajo payments made and on-time %, savings consistency, verified assets with level and status (no
  photos, no names), loans taken and repaid, current loan status. Every line shows "Read from
  Stellar" with a link. No personal data, no name, no ID.
- [ ] The page shows how long the verification took.

## Piece 10 (after piece 8; reads from `plus_credit`): The ajo vouches

- [ ] Members of an ajo in good standing (verified ID, 6+ weeks, all ajo payments on time) can
  vouch for another member's loan by voice ("I vouch for Funmi") or tap, with PIN.
- [ ] Each vouch is recorded on `plus_credit`. A loan backed by two or more vouches needs less
  collateral (a first loan drops from 150% to 100%), and the offer screen explains why.
- [ ] A voucher whose vouched loan defaults loses vouching rights for 6 months; no money is taken
  from them.
- [ ] Show vouches on the loan offer and on the `/verify` page.
