-- chain_outbox: contract writes waiting to go to Stellar. Voice tools and app actions never
-- wait on the chain: the sim_* money functions insert a row here in the same transaction,
-- and chain-worker submits them one at a time per signing account.
--   queued    -> waiting (or waiting to retry after next_attempt_at)
--   submitted -> signed, tx_hash saved BEFORE sending; the worker looks it up by hash first
--   done      -> succeeded on-chain
--   failed    -> last attempt failed; retried with backoff while attempts < 8, stays visible
create table public.chain_outbox (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('attest', 'group_record')),
  args jsonb not null,
  ref text not null unique check (ref <> ''),       -- one row per money movement, never two
  signer text not null default 'partner',
  status text not null default 'queued' check (status in ('queued', 'submitted', 'done', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  tx_hash text check (tx_hash ~ '^[0-9a-f]{64}$'),
  tx_valid_until timestamptz,                       -- signed envelope's max time
  last_error text,
  submitted_at timestamptz,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index chain_outbox_work_idx on public.chain_outbox (signer, status, next_attempt_at)
  where status in ('queued', 'submitted', 'failed');

create trigger chain_outbox_updated_at before update on public.chain_outbox
  for each row execute function public.set_updated_at();

alter table public.chain_outbox enable row level security;
revoke all on public.chain_outbox from anon, authenticated;
