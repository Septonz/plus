# Spike: voice tool latency

**Date:** 2026-11-09 · **Script:** [`scripts/spikes/latency.ts`](../../scripts/spikes/latency.ts) · **Function:** `agent-tools` (Supabase Edge Functions, project `qoqmnjzfjhpemwleipth`) · **Budget:** 5 s per tool call in a voice turn

**Question:** do the agent's tools answer fast enough for a voice conversation, and can a tool afford a live contract read?

**Answer:** the database tools take about 0.1 s and are well inside the budget. A live Soroban read through the public testnet RPC takes 5 to 14 s and is not. Voice tools read Postgres only. Chain state reaches Postgres through `sync-events` (`chain_events`) and the seed mirrors.

## Results

Second run, 20 calls per tool, called as WhatsApp would (caller id without `+`). Round trip is measured from the developer's machine. "Server" is the function's own `latency_ms`.

| Tool | Calls | Errors | First (ms) | p50 (ms) | p95 (ms) | Server p50 (ms) | Server p95 (ms) |
| ---- | ----- | ------ | ---------- | -------- | -------- | --------------- | --------------- |
| `get_user` | 20 | 0 | 860 (cold start) | 136 | 198 | 58 | 118 |
| `get_balance` | 20 | 0 | 157 | 115 | 150 | 49 | 64 |
| `what_arrived` | 20 | 0 | 135 | 122 | 150 | 54 | 88 |
| `record_of` (contract read, inside the function) | 10 | 0 | 6,073 | 5,306 | 6,395 | simulate 5,184 | simulate 6,237 |

- First run: the tools were within 20 ms of these numbers. `record_of` gave p50 6,172 ms and p95 14,301 ms.
- Stellar SDK import inside the function: about 160 ms the first time, then 0 ms. It is imported lazily, so voice tools never pay for it.
- A wrong `x-plus-secret` returns `401`. Every call is in `tool_calls` with its latency. The caller's number is never logged.

## Why the contract read is slow

It isn't the contract. The public RPC `soroban-testnet.stellar.org` was slow for everything during the test. Measured with `curl`, `getHealth` took 0.17 s, 7.0 s and 0.43 s, and `getLatestLedger` took 5.5 s, 7.1 s and 0.26 s. The SDF testnet RPC is a free shared service and makes no promise about latency. The seed script also hit RPC timeouts earlier.

## Decision

- **Voice path reads Postgres only.** `get_user`, `get_balance` and `what_arrived` read Postgres only, with a server p95 of 64 to 118 ms. That leaves the 5 s budget for the LLM and TTS.
- **Chain data is mirrored.** `my_record` and `group_status` will read `chain_events` and `groups`, kept up to date by `sync-events`, not the live RPC.
- **Writes are asynchronous.** Contract writes (attestations, group records) happen after `confirm_action` replies. The agent says "done" when Postgres commits. The transaction hash is saved before polling, and the result arrives by Realtime.
- If a live read is ever needed in a turn, use a dedicated RPC provider with a timeout of about 2 s and fall back to the mirror. Re-measure before relying on it.
