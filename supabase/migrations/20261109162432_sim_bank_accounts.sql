-- sim_bank_accounts: simulated partner-bank accounts for Indian users (rupees stay in the bank).
create table public.sim_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users (id) on delete cascade,
  balance_paise bigint not null default 0 check (balance_paise >= 0),
  savings_paise bigint not null default 0 check (savings_paise >= 0),
  bank_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger sim_bank_accounts_updated_at before update on public.sim_bank_accounts
  for each row execute function public.set_updated_at();

alter table public.sim_bank_accounts enable row level security;
