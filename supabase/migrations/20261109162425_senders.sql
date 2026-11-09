-- senders: family abroad who send money to a Plus user (SEP-31, family pots).
create table public.senders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country text not null check (country ~ '^[A-Z]{2}$'),   -- ISO 3166-1 alpha-2
  stellar_pub text check (stellar_pub ~ '^G[A-Z2-7]{55}$'),
  secret_name text,
  user_id uuid references public.users (id) on delete set null,   -- the family member in Plus
  created_at timestamptz not null default now()
);

create index senders_user_id_idx on public.senders (user_id);

alter table public.senders enable row level security;
