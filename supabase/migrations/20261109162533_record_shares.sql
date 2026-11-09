-- record_shares: a user's consent to share their record with a lender, until expires_at.
create table public.record_shares (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  lender text not null,
  consented_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint record_shares_window check (expires_at > consented_at)
);

create index record_shares_user_id_idx on public.record_shares (user_id, expires_at desc);

alter table public.record_shares enable row level security;
