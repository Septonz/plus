-- sync_state: cursors for background syncs (e.g. key 'chain_events' -> last RPC cursor).
create table public.sync_state (
  key text primary key,
  cursor text not null,
  updated_at timestamptz not null default now()
);

create trigger sync_state_updated_at before update on public.sync_state
  for each row execute function public.set_updated_at();

alter table public.sync_state enable row level security;
