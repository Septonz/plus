# Market packs

Plus is one shared core plus a market pack per country. The source of truth is
`packages/markets/src/markets.ts`; edit it there and run `pnpm markets:sync`.
India is the primary market. Nigeria is a smaller second pack that proves the core is reusable.

| Setting | India (`in`) | Nigeria (`ng`) |
| ------- | ------------ | -------------- |
| Currency | INR ₹, off-chain (partner bank) | NGN ₦, on-chain test asset (NGNT) |
| Languages | Tamil, English | English (incl. Pidgin), Yoruba, Hausa, Igbo |
| Custody | Partner bank (simulated) | User's own Stellar account |
| USD balance | No | Yes (optional USDC) |
| Domestic rail | UPI (simulated) | Stellar |
| Cash-out | Agent guidance | Claimable code |
| Incoming sources | State transfer, wages, family abroad | Deposit |
| Inbound corridors | CA (SEP-31, test anchor) | None |
| Auto-save | On, 10% (1000 bps) | On, 10% (1000 bps) |
| Group savings | Seettu, recorded on-chain | Ajo, pooled in the contract |
| Advance | ₹2,000 to ₹10,000, 1.5% fee, after 8 weeks | ₦5,000 to ₦30,000, 1.5% fee, after 8 weeks |
| Record | Attested (on-chain hashes) | Native (on-chain history) |
| PIN required above | ₹2,000 | ₦20,000 |
| ID check | Partner KYC (mock) | NIN (mock) |

Both packs expose the same services: `get_user`, `start_onboarding`, `verify_id`, `set_pin`,
`get_balance`, `what_arrived`, `set_auto_save`, `prepare_pay`, `prepare_save`, `prepare_cashout`,
`prepare_group_contribution`, `prepare_advance`, `confirm_action`, `group_status`, `my_record`, `share_record`.

Indian users never hold crypto: rupees stay in the partner bank and Stellar carries only records,
attestations, advance limits, family pots and inbound SEP-31 transfers.
