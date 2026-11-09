-- payees: people and shops a user pays (UPI in India, Stellar in Nigeria).
create table public.payees (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null,
  stellar_address text check (stellar_address ~ '^[GM][A-Z2-7]{55,}$'),
  upi_handle text check (upi_handle ~ '^[A-Za-z0-9._-]+@[A-Za-z0-9]+$'),
  created_at timestamptz not null default now(),
  constraint payees_destination check (stellar_address is not null or upi_handle is not null),
  unique (user_id, name)
);

alter table public.payees enable row level security;
