-- user_credentials: PIN material, kept apart from users so no read policy can ever expose it.
-- pin_hash = HMAC-SHA256(PIN_PEPPER, salt || pin), hex. The pepper lives only in Supabase secrets.
-- Locked for 15 minutes after 3 failed attempts (see supabase/functions/_shared/pin.ts).
-- RLS on with no policies at all: only the service role (Edge Functions) can read or write it.
create table public.user_credentials (
  user_id uuid primary key references public.users (id) on delete cascade,
  pin_hash text not null check (pin_hash ~ '^[0-9a-f]{64}$'),
  pin_salt text not null check (pin_salt ~ '^[0-9a-f]{32}$'),
  failed_attempts smallint not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger user_credentials_updated_at before update on public.user_credentials
  for each row execute function public.set_updated_at();

alter table public.user_credentials enable row level security;
revoke all on public.user_credentials from anon, authenticated;
