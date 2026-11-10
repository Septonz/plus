# Roadmap

The plan for pieces 3 to 8, saved so it survives new sessions. Tick an item (`[x]`) when it is
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

- [ ] **Kemi** (new user, week 4 of 6): can save, transact, register and verify assets. She sees
  "Building your Plus history, week 4 of 6" with a checklist: identity verified, qualifying
  transactions, active weeks, one verified asset, and 2 more weeks needed. Also an estimated future
  range marked "estimate, not an offer". Never the words "rejected" or "not eligible". New sign-ups
  land in this view at week 1 of 6.
- [ ] **Unlock rules:** account open 6+ weeks, money in during at least 4 of them, a minimum number
  of qualifying transactions, verified identity, good standing. Circular or back-and-forth
  transfers don't count.
- [ ] **Funmi** (unlocked, 8+ weeks, verified stall stock): a loan offer showing why she got it
  (activity 40%, verified assets 35%, savings consistency 25%), written as "you receive ₦30,000,
  cost ₦1,800, total ₦31,800". Repayment: 10% of every money-in plus a minimum of ₦2,500 every two
  weeks.
- [ ] **Rewards ladder**, shown before she accepts: next loan ₦50,000 at 5%, then ₦80,000 at 4.5%;
  collateral 150% → 125% → 100% → partial; faster approval.
- [ ] **Affordability first:** stall stock estimated ₦90,000, lending value ₦54,000, affordable
  limit ₦30,000, so the lower one wins.
- [ ] **Accepting needs the PIN pad.** Funds go as NGNT from a partner lending account to Funmi
  through the outbox (real Testnet), with loan state in the database. Repayments (10% of each
  money-in, and the two-weekly minimum from the scheduler) go as NGNT back to the lending account.
- [ ] **Repay screen** with "I need more time", which offers a short extension and pauses new
  borrowing. Missed payment path: reminder, grace period, restructure, borrowing frozen; never
  contact anyone else.
- [ ] Retire the old 1.5% advance from the UI but keep its contract functions.

## Piece 5: Assets, from day one, for any user

- [ ] Register by voice or tap: type (stock, tools, machine, motorcycle, livestock), description,
  estimated value.
- [ ] **Verification levels:** Registered → Evidence verified (live photo, which voice can trigger
  with "take the photo", plus timestamp and approximate location; photo stored privately, only a
  hash in the DB) → Community verified (two eligible witnesses confirm; eligible = verified ID,
  account older than 6 weeks, good standing; Mama Bisi and Amaka can confirm from /agent) →
  Independently verified (agent inspection from /agent).
- [ ] **Statuses:** Active, Under review, Lost, Stolen, Damaged, Released.
- [ ] Customers see the level; an internal confidence score is kept for lenders. Funmi's stall
  stock is seeded as Independently verified.

## Piece 6: Demo reset and README

- [ ] `pnpm demo:reset ng` resets Kemi and Funmi to their starting states (Funmi: no loan open,
  offer available; Kemi: week 4 of 6).
- [ ] README: both demo users, a 60-second demo script, and a plain list of what's simulated.

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
