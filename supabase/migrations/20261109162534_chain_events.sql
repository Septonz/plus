-- chain_events: Plus contract events synced from Stellar RPC (sync-events).
create table public.chain_events (
  id bigint generated always as identity primary key,
  event_id text not null unique,           -- RPC event id, makes the sync idempotent
  ledger bigint not null,
  tx_hash text not null check (tx_hash ~ '^[0-9a-f]{64}$'),
  type text not null,                      -- event name, e.g. group_contributed
  topics jsonb not null,
  data jsonb,
  created_at timestamptz not null default now()   -- ledger close time when known
);

create index chain_events_ledger_idx on public.chain_events (ledger);
create index chain_events_type_idx on public.chain_events (type, ledger desc);

alter table public.chain_events enable row level security;
alter publication supabase_realtime add table public.chain_events;
