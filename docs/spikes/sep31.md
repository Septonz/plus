# Spike: SEP-31 send to India via testanchor.stellar.org

**Date:** 2026-11-09 · **Network:** Stellar Testnet · **Time-box:** 60 min (stopped at ~20 min) · **Scripts:** [`scripts/spikes/sep31.ts`](../../scripts/spikes/sep31.ts), [`scripts/spikes/sep6-withdraw.ts`](../../scripts/spikes/sep6-withdraw.ts) (throwaway, kept for reference)

**Question:** can Selvi's son in Canada (`sender_ca`, holding Circle testnet USDC) send money to India over SEP-31 using SDF's public test anchor?

**Answer:** not today. Discovery, auth and KYC work, but the test anchor has **no SEP-31 receive configuration for any asset**, so no transaction can be created. No payment was sent and no USDC was spent.

**Decision:** Plus builds its own INR **receiving anchor** as a Supabase Edge Function called `anchor` (SEP-1/10/12/38/31), with `stellar.toml` served by the web app. See [Decision](#decision).

## What we tried

| Step | Result | Time |
| ---- | ------ | ---- |
| SEP-1 `/.well-known/stellar.toml` | ✅ endpoints found | ~0.2 s |
| SEP-10 challenge, sign, token | ✅ JWT for `sender_ca` | 0.3–5.8 s |
| SEP-31 `GET /info` | ❌ `{"receive":{}}` with and without JWT | ~0.1 s |
| SEP-12 `GET /customer?type=…` | ✅ field lists for `sep31-sender`, `sep31-receiver` | ~0.1 s |
| SEP-12 `PUT /customer` (fake data) | ✅ `202 {"id": …}` for both types | ~1.6 s each |
| SEP-38 `GET /prices` (sell USDC) | ❌ `502 Bad gateway` (intermittent) | — |
| SEP-38 `GET /prices` + `POST /quote` (sell SRT) | ✅ quote returned | 0.1 s + 1.1 s |
| SEP-31 `POST /transactions` (USDC) | ❌ `Asset [USDC] has no fields definition` | ~0.1 s |
| SEP-31 `POST /transactions` (SRT, XLM) | ❌ same / `Sep31Info.getReceive() is null` | ~0.1 s |
| Fallback: SEP-6 `GET /withdraw` 5 USDC | ⚠️ created, but stuck in `incomplete` for 6+ min; never returned an account to pay | — |

## Anchor details (as observed)

### SEP-1

```toml
NETWORK_PASSPHRASE    = "Test SDF Network ; September 2015"
SIGNING_KEY           = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR"
WEB_AUTH_ENDPOINT     = "https://testanchor.stellar.org/auth"     # SEP-10
KYC_SERVER            = "https://testanchor.stellar.org/sep12"    # SEP-12
DIRECT_PAYMENT_SERVER = "https://testanchor.stellar.org/sep31"    # SEP-31
ANCHOR_QUOTE_SERVER   = "https://testanchor.stellar.org/sep38"    # SEP-38
TRANSFER_SERVER       = "https://testanchor.stellar.org/sep6"
TRANSFER_SERVER_SEP0024 = "https://testanchor.stellar.org/sep24"
```

Currencies: `SRT` (`GCDNJUBQ…JY6B`, SDF test asset), `USDC` (`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`, **Circle testnet USDC, the same asset our contract uses**), and `native`.

### SEP-10

`GET /auth?account=<G…>&home_domain=testanchor.stellar.org` → `{ transaction, network_passphrase }`. Verify with `WebAuth.readChallengeTx(tx, SIGNING_KEY, passphrase, "testanchor.stellar.org", "testanchor.stellar.org")`, sign with the client key, `POST /auth { transaction }` → `{ token }` (JWT, ~450 chars).

### SEP-12

- Customers are keyed by **Stellar account (+ memo)**. A `PUT` for `sep31-sender` and a `PUT` for `sep31-receiver` from the same account returned **the same `id`**. One sending account acting for many people must use a distinct `memo` per customer.
- `PUT /customer` body is flat JSON: `{ account, type, <fields…> }` → `202 { "id": "<uuid>" }`; `GET /customer` → `{ status: "NEEDS_INFO" | "ACCEPTED" | …, fields: { name: { type, description, choices, optional } } }`.

| Type | Required | Notable optional |
| ---- | -------- | ---------------- |
| `sep31-sender` | `first_name`, `last_name`, `email_address` | `address`, `address_country_code`, `mobile_number`, `birth_date`, `id_type`, `id_number`, `id_country_code`, `bank_*`, `photo_id_*` |
| `sep31-receiver` | `bank_account_type` | `bank_name`, `bank_account_number`, `bank_number`, `bank_branch_number`, `mobile_money_number`, `mobile_money_provider`, `tax_id`, `id_*` |

(The receiver's name fields were already satisfied by the shared customer record, which is why only `bank_account_type` was still required.)

### SEP-38

`GET /info` lists `stellar:SRT:…`, `stellar:USDC:…`, `stellar:native`, `iso4217:USD` (country `US`, delivery `WIRE`) and `iso4217:CAD` (country `CA`, delivery `WIRE`). **No INR.**

`GET /prices?sell_asset=<asset>&sell_amount=5&context=sep31`:

```json
{ "buy_assets": [{ "asset": "iso4217:USD", "price": "6.9001207521", "decimals": 4 }] }
```

`POST /quote { sell_asset, buy_asset, sell_amount, context: "sep31" }`:

```json
{
  "id": "72ac4065-…", "expires_at": "2026-11-10T12:00:00Z",
  "price": "6.9001207521", "total_price": "8.6251509401",
  "sell_asset": "stellar:SRT:GCDNJUBQ…JY6B", "sell_amount": "5",
  "buy_asset": "iso4217:USD", "buy_amount": "0.5797",
  "fee": { "total": "1.00", "asset": "stellar:SRT:…",
           "details": [{ "name": "Sell fee", "description": "Fee related to selling the asset.", "amount": "1.00" }] }
}
```

Formats: assets are SEP-38 identifiers (`stellar:CODE:ISSUER`, `iso4217:XXX`); amounts and prices are decimal **strings**; the fee is charged in the sell asset; fiat has 4 decimals here.

### SEP-31

`POST /transactions` (Bearer JWT):

```json
{
  "amount": "5",
  "asset_code": "USDC",
  "asset_issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "sender_id": "<sep12 id>",
  "receiver_id": "<sep12 id>",
  "funding_method": "SWIFT",
  "quote_id": "<optional sep38 id>",
  "fields": { "transaction": { "…": "…" } }
}
```

Validation order observed:

1. `funding_method` is **required** (`funding_method cannot be empty`): the newer SEP-31 field.
2. It must match the asset's configured methods (`invalid funding method SWIFT for asset stellar:SRT:…, supported types are [bank_account]`).
3. The asset must have a SEP-31 receive config (`Asset [USDC] has no fields definition`): this is where every asset failed.

Per the SEP-31 flow, the response (or `GET /transactions/:id`) should then give `stellar_account_id`, `stellar_memo` and `stellar_memo_type` to pay, with statuses moving through `pending_sender` → `pending_stellar` → … → `completed`.

## Why receiving failed

The test anchor runs the Stellar Anchor Platform. SEP-31 receiving is enabled per asset in its asset config (`sep31.enabled`, `receive` limits, `sep12` sender/receiver types, `fields`, `funding_methods`). On `testanchor.stellar.org` no asset has that block, so `/info` is empty and `POST /transactions` rejects every asset. It is a server-side configuration gap, not something a client can work around. The intermittent SEP-38 502s and the SEP-6 withdrawal stuck in `incomplete` (KYC `ACCEPTED`) suggest the anchor's business server was also unhealthy at the time.

## Decision

Plus builds its **own INR receiving anchor**: a Supabase Edge Function named **`anchor`**.

- **SEP-1:** `stellar.toml` is served by the web app at `/.well-known/stellar.toml`, pointing at the `anchor` function's endpoints.
- **SEP-10:** challenge and JWT, signed with an anchor signing key held in Supabase secrets.
- **SEP-12:** `sep31-sender` / `sep31-receiver` customers. The receiver is a Plus user, identified internally by phone and on-chain only by `userRef(phone)` (HMAC). No Aadhaar, no personal data on-chain.
- **SEP-38:** `stellar:USDC:GBBD47…` → `iso4217:INR` quotes, in the same response shapes as above.
- **SEP-31:** `/info` (Circle USDC, `funding_method` e.g. `bank_account`, `bank_account_type` choices), `POST /transactions` returning an account plus a per-transaction memo, and `GET /transactions/:id`. The incoming payment is matched by memo, then paid out in INR through `payout-sim` (partner bank / UPI simulation). The Indian user never holds crypto.

This matches reality: in production the Indian partner bank *is* the receiving anchor, and it removes the dependency on a shared test service. The sender side (`sender-api` + sender page) acts as the SEP-31 sending client against `anchor`.

### Impact on the sender page and `sender-api`

- Collect sender KYC fields `first_name`, `last_name`, `email_address` once; reuse the SEP-12 id.
- One sending account for many senders: use a **distinct SEP-12 memo per customer**.
- Always send `funding_method`; show the SEP-38 fee (charged in USDC) and the INR amount before confirming.
- Use prepare → confirm, and save the payment hash before polling (CLAUDE.md money rules).
- Don't depend on testanchor.stellar.org for the demo.
