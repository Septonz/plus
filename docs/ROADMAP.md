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

- [x] On Pay: a 10-digit account number and a bank from a generic list. A simulated account-name
  lookup ("Account name: ADEBAYO STORES") is shown before she confirms.
- [x] On confirm, NGNT goes from her wallet to `anchor_ng` through the outbox, as an anchor
  withdrawal, shown as "Sent to bank (partner, simulated)" with the Stellar tick.
- [x] Voice: "Send ₦8,000 to my landlord's bank account". Same confirm rules. No real bank or
  company names except a generic bank list.
- Done 2026-11-10: Pay has a "To a bank" tab (six fictional banks, 10-digit number, the name shown
  as soon as the number is complete, optional "Save it as"); saved bank accounts sit in her saved
  list. Voice tools `bank_lookup` and `prepare_bank_send`; above ₦5,000 needs her PIN. `pnpm e2e:bank`
  passes on testnet: ₦2,000 Yes → on Stellar to `anchor_ng` in 8.4 s, a retried Yes sends nothing twice.

## Piece 8 (Wednesday, after the rest): `plus_credit` contract

- [x] A `plus_credit` Soroban contract, deployed alongside the existing one. It holds each loan
  agreement (borrower ref, lender, principal, cost, total, repaid, repayment %, minimum, collateral
  ref, status: Active, Late, Restructured, Repaid, Default) and each asset's reference (anonymous
  asset ID, verification hash, level, collateral status). No personal data on-chain.
- [x] The backend writes to it through the outbox at every loan and asset change, and the app's
  small "Verified on Stellar" tick links to it.
- Done 2026-11-10: `plus_credit` [`CCLO7QV3…DZCC`](https://stellar.expert/explorer/testnet/contract/CCLO7QV3LC4MPC46ZBYZDGNOVEYTY62SDRV6S4KZ7O5LVAA7RMX6DZCC)
  next to `plus` (unchanged). Partner or admin write (with their signature), anyone reads; HMAC
  references only (key in Vault). Adds a Cancelled status for loans the demo reset settles, vouches
  (for piece 10) and an admin `upgrade`. 21 unit tests. Postgres triggers write every loan, repayment
  and asset change through partner's outbox queue; 13 writes backfilled (5 assets incl. Funmi's stall
  stock, 2 loans with 4 repayments, 2 asset statuses). `pnpm e2e:loan` step 8 reads it back from
  Stellar; `pnpm demo:ready` checks it. Funmi had no open loan to backfill.

## Piece 9 (after piece 8; reads from `plus_credit`): Verify a Plus record, the key demo moment

- [x] Funmi can say "share my record with the lender" or tap Share on My record: consent screen,
  PIN, then a one-time 8-character code valid for 24 hours. Every share is logged and can be
  revoked.
- [x] A public page `/verify` (no login): a lender enters the code and sees, read directly from
  Stellar (`plus_credit` contract and contract events), an anonymous summary: months of history,
  ajo payments made and on-time %, savings consistency, verified assets with level and status (no
  photos, no names), loans taken and repaid, current loan status. Every line shows "Read from
  Stellar" with a link. No personal data, no name, no ID.
- [x] The page shows how long the verification took.
- Done 2026-11-10: My record → "Share my record" (or "share my record with the lender"): what the
  lender sees and never sees, her PIN (always), then a code like `ABCD-EFGH` on her screen only.
  Only an HMAC of the code is stored. One-time: the first lender keeps it for an hour (refreshes),
  anyone else is refused; 24 hours; revoke one or all; every share and attempt logged, her list
  shows "opened by a lender, 2 views". `/verify` reads plus_credit (loans, assets, vouches), her
  wallet's history on Horizon (ajo payments into the plus contract) and plus_credit's events in
  the browser; Plus only turns the code into her two public references. Verified in 0.8-2.8 s.
  Wrong codes: 10 per viewer and 300 overall per 10 minutes (viewer = Cloudflare's address, not
  the spoofable x-forwarded-for). `pnpm e2e:verify` (`--keep` leaves a code open to try by hand).

## Piece 10 (after piece 8; reads from `plus_credit`): The ajo vouches

- [x] Members of an ajo in good standing (verified ID, 6+ weeks, all ajo payments on time) can
  vouch for another member's loan by voice ("I vouch for Funmi") or tap, with PIN.
- [x] Each vouch is recorded on `plus_credit`. A loan backed by two or more vouches needs less
  collateral (a first loan drops from 150% to 100%), and the offer screen explains why.
- [x] A voucher whose vouched loan defaults loses vouching rights for 6 months; no money is taken
  from them.
- [x] Show vouches on the loan offer and on the `/verify` page.
- Done 2026-11-10: "I vouch for Funmi" (voice) or **Vouch** on the Ajo screen, with her PIN.
  Good standing is checked when she asks and again on her PIN: verified ID, 6+ weeks, no late or
  defaulted loan, not banned, and every ajo payment on time, read from her `contributed` events
  on the plus contract. Each vouch and withdrawal goes to plus_credit through the partner's queue;
  at loan_open the waiting vouches attach to the loan. Two vouches: 100% collateral instead of 150%
  (market pack `lending.vouch`), explained on the offer ("Amaka and Tunde vouched for you"), on the
  loan ("Vouched for by"), and on `/verify`. Default: vouchers banned 6 months, their other waiting
  vouches withdrawn, a `VouchedLoanDefaulted` event each; no money moves. `pnpm e2e:vouch`.

## Piece 11: Demo hardening and closing the gaps

Pitch from a phone tomorrow: every screen finished, every action possible by voice. Branch
`feat/piece-11-demo-ready`, one commit per item, in this order.

P0 (the first 30 seconds)
- [x] 1. Activity looks like Funmi's (and Selvi's) real life: hide `adjustment` and demo-reset rows
  in tools and lists (kept in the DB); `demo:reset` ends with 6-8 curated, real testnet movements
  over ~10 days (DB `created_at` backdated for display; the chain time stays true). The Loan
  screen's activity figures, Activity and /verify agree, or say where they come from.
- [x] 2. The floating mic never covers content: dock it in the tab bar's centre (checked at 375x812, 360x740).
- [x] 3. Payment confirm ≤ 5 s (about 3 s): DEMO_WARM on, warm every 60-second-demo path, and
  `demo:ready` prints the measured times.
- [x] 4. Landing page markets panel from markets.ts: "Loans ₦30,000 → ₦80,000, from 6%"; real
  languages only (English, Pidgin, Yoruba; Tamil and English).
- [x] 5. 12-hour times everywhere through one `formatTime` helper.

P1 (product gaps)
- [x] 6. Nigeria Savings on Stellar: a goal pot on the plus contract (pot_create/pot_fund/pot_send),
  Savings card and sheet, auto-save 0/5/10/20% of money-in after loan repayment, voice tools
  (`savings_status`, `prepare_save`, `prepare_withdraw_savings`, `set_savings_goal`,
  `set_auto_save`), savings consistency counts savings, demo: "Stall shade" ₦18,500 of ₦50,000.
  Dollar savings: path payment, next (not built in piece 11, so the app never shows a USD figure).
- [x] 7. Pay a shop: "My code" (QR + short pay code) and "Scan to pay" (camera, or type the code),
  same prepare_pay flow; voice `navigate("receive")` and `prepare_pay` with `code`.
- [x] 8. Loan screen: one "You receive", Cost and Total rows; ladder rungs 3-4 merged (in markets.ts
  copy too); a repayment example.
- [x] 9. Ajo sheet: no duplicate Yoruba subtitle (global rule), amount, members, payout, her turn,
  who has paid.
- [x] 10. Vouch copy is gender-neutral (screens, /verify, tools, prompt).
- [x] 11. Wallet sheet's button pair fits on one line at 375px.
- [x] 12. Profile: account number label + copy, language row, Stellar details, PIN behind "Change PIN".
- [x] 13. Agent page: "Earned today", demo-reset rows hidden.
- [x] 14. /verify: "Try a sample record" when demo logins are on.
- [x] 15. Sheets underneath don't take clicks while animating.

P2 (voice drives everything)
- [x] 16. `scripts/voice-coverage.ts`: every app action maps to a voice tool; prompts updated; agents:sync.
- [x] 17. Language consistency: the confirm sheet and its follow-ups in the user's language (translations.ts).
- [x] 18. `scripts/e2e-ng.ts` runs the 60-second demo by tool calls only; passes twice after a reset.

Finish: README demo script (savings, shop pay), fresh docs/screens (`pnpm screens`), tick here,
PR merged on green CI, Vercel live, `pnpm demo:ready ng` and `pnpm demo:ready in`.

## Piece 12: Public test mode

Anyone with the link (judges, other teams, Devpost visitors) can open plus-wallet.vercel.app and try
the whole app right away, with no setup and no help. Public testers never spend ElevenLabs credits
(voice is for our presenter devices), never interfere with each other, and never touch Funmi, Kemi,
Amaka or Mama Bisi. Branch `feat/piece-12-public-test`, one commit per item.

- [ ] 1. Voice modes and a kill switch: `VOICE_MODE` off | presenter (default) | on; presenter
  unlock by staff login or a presenter code (`VOICE_PRESENTER_CODE`, constant-time, 7-day signed
  token on the device); daily cap `VOICE_DAILY_SESSION_CAP` (40); 180-second conversations
  (agents:sync); a calm "Voice is switched on for live demos" sheet with the demo video
  (`VITE_DEMO_VIDEO_URL`) and what Funmi would say.
- [ ] 2. Guest traders: "Try Plus now" signs in as one of 20 pre-seeded guests (`GUEST_POOL_SIZE`),
  each with Funmi's full story; least-recently-used idle guest, same device kept for 2 hours;
  `pnpm guests:seed`, `pnpm guests:reset` (on reassignment and nightly); 10 new guest sessions per IP
  an hour; guests can't pay or reach the presenter accounts; a friendly rate-limit message.
- [ ] 3. Everything reachable by taps: pretend cash-in from a demo agent, Mama Put Canteen pay
  code under Scan, pretend agent pay-out, guest PIN 1234 with a hint and a 1-minute lockout, sign-up
  by taps.
- [ ] 4. A 2-minute tester guide: on the landing page and as a dismissible checklist on a guest's
  Home, ticked from the guest's own activity; nothing extra on presenter accounts.
- [ ] 5. Landing page: Try Plus now, Try the agent app (3 guest agents), Verify a record, Watch the
  demo, a small Presenters link (demo logins and /demo).
- [ ] 6. Readiness: `pnpm demo:ready ng` checks the guest pool, the demo agent's float and the voice
  mode; `pnpm guests:status`; treasury runway.
- [ ] 7. Docs: README "Try it now" and "For presenters"; fresh screens.
