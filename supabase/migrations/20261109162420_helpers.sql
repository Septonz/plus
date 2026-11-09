-- helpers: group leaders, bank correspondents and cash agents who record cash for users.
create table public.helpers (
  id uuid primary key default gen_random_uuid(),
  market_id text not null check (market_id in ('in', 'ng')),
  name text not null,
  phone text not null unique check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  role text not null check (role in ('group_leader', 'correspondent', 'agent')),
  stellar_pub text check (stellar_pub ~ '^G[A-Z2-7]{55}$'),
  secret_name text,
  daily_limit bigint not null check (daily_limit > 0),   -- minor units (paise or kobo)
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger helpers_updated_at before update on public.helpers
  for each row execute function public.set_updated_at();

alter table public.helpers enable row level security;
