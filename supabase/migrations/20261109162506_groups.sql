-- groups: mirror of on-chain groups (seettu in record mode, ajo pooled).
create table public.groups (
  id uuid primary key default gen_random_uuid(),
  market_id text not null check (market_id in ('in', 'ng')),
  name text not null,
  mode text not null check (mode in ('record', 'pooled')),
  onchain_id bigint unique check (onchain_id >= 0),   -- contract group id
  amount bigint not null check (amount > 0),          -- per period, minor units
  period_secs integer not null check (period_secs > 0),
  next_due timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger groups_updated_at before update on public.groups
  for each row execute function public.set_updated_at();

alter table public.groups enable row level security;
