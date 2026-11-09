-- users: one row per Plus user (India or Nigeria). Written only by Edge Functions (service role).
create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create table public.users (
  id uuid primary key default gen_random_uuid(),
  market_id text not null check (market_id in ('in', 'ng')),
  wa_phone text not null unique check (wa_phone ~ '^\+[1-9][0-9]{7,14}$'),   -- E.164
  name text,
  language text not null,
  kyc_tier smallint not null default 0 check (kyc_tier between 0 and 3),
  stellar_pub text check (stellar_pub ~ '^G[A-Z2-7]{55}$'),
  secret_name text,                       -- name of the secret holding the key, never the key
  ref_hash text unique check (ref_hash ~ '^[0-9a-f]{64}$'),   -- on-chain user_ref (hex)
  auto_save_bps integer not null default 1000 check (auto_save_bps between 0 and 10000),
  trusted_contact_phone text check (trusted_contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Indian users never hold crypto.
  constraint users_in_no_stellar check (market_id <> 'in' or (stellar_pub is null and secret_name is null))
);

create trigger users_updated_at before update on public.users
  for each row execute function public.set_updated_at();

alter table public.users enable row level security;
