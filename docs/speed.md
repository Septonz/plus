# Speed: from her Yes to the tick

Target: under 10 seconds from her Yes until the transaction is in a closed ledger and the app can
show the tick. Testnet ledgers close about every 5 seconds, so that is the floor.

## What chain-worker does now

- **One queue per signing account** (`chain_outbox.signer`: partner, funmi, agent_ng, ...). Queues run
  in parallel, each under its own lease in `chain_signers`; within an account still one transaction
  at a time, oldest first. `after_id` makes a row wait for another row, possibly on another queue.
- **Classic operations through Horizon** (payments, claimable balances): `POST /transactions_async`,
  then `GET /transactions/{hash}`. **Contract calls through RPC** (simulate, send, getTransaction).
- **RPC: Gateway first, SDF default as fallback** (`STELLAR_RPC_URL`). On a network error the same
  signed envelope goes to the fallback: same hash, same sequence number, so it can never apply twice.
- **Polls every second.** The hash (and a claimable balance id) is saved before sending; an unknown
  outcome is always looked up by hash before anything is resent.
- Sequence numbers are cached within a run (one account read per run instead of one per transaction).

## RPC benchmark (`pnpm bench:rpc`), 2026-11-09

20 sequential submit + confirm round trips each (a no-op bump-sequence transaction from a throwaway
friendbot account), polling every 250 ms.

From the Supabase Edge region (where chain-worker runs; temporary `rpc-bench` function):

| Endpoint | send p50 | getTransaction p50 | send → confirmed p50 / p90 |
| -------- | -------- | ------------------ | -------------------------- |
| Gateway `https://soroban-rpc.testnet.stellar.gateway.fm` | 109 ms | 106 ms | 4.9 s / 5.2 s |
| Horizon `https://horizon-testnet.stellar.org` (classic) | 18 ms | 19 ms | 4.9 s / 5.2 s |
| SDF default `https://soroban-testnet.stellar.org` (8 runs; 20 exceeded the function's time limit) | 1,380 ms | 3,690 ms | 9.8 s / 12.2 s |
| Nodies `https://stellar-soroban-testnet-public.nodies.app` | 404 on every request, including `getHealth` | | |

From a laptop: Gateway 5.0 s / 5.4 s, Horizon 5.0 s / 5.2 s, SDF default 10.8 s / 16.0 s
(send p50 2.0 s, getTransaction p50 6.3 s), Nodies 404.

## Before and after (`pnpm bench:confirm`), empty queue

| | Before (one partner queue, SDF RPC, 1.5 s polling) | After |
| - | - | - |
| Contract call (India pay Yes → attest) | median 10.6 s (8.2 to 26.8 s); 30 to 98 s when queued behind other rows | median 4.6 s (4.4 to 4.7 s) |
| Classic payment (Horizon) | no payment path existed | median 4.7 s (3.7 to 5.2 s) |
