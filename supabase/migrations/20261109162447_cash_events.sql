-- cash_events: cash handed to or from a helper. A cash-in counts only after the user confirms it.
create table public.cash_events (
  id uuid primary key default gen_random_uuid(),
  helper_id uuid not null references public.helpers (id) on delete restrict,
  user_id uuid not null references public.users (id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  amount bigint not null check (amount > 0),   -- minor units (paise or kobo)
  status text not null default 'awaiting_user'
    check (status in ('awaiting_user', 'confirmed', 'rejected', 'expired')),
  pending_action_id uuid references public.pending_actions (id) on delete set null,
  rail_ref text,                               -- bank / Stellar reference once settled
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index cash_events_user_status_idx on public.cash_events (user_id, status, created_at desc);
create index cash_events_helper_day_idx on public.cash_events (helper_id, created_at);   -- daily limit
create index cash_events_pending_action_idx on public.cash_events (pending_action_id);

create trigger cash_events_updated_at before update on public.cash_events
  for each row execute function public.set_updated_at();

alter table public.cash_events enable row level security;
alter publication supabase_realtime add table public.cash_events;
