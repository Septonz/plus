-- transactions: the user's money history across rails. amount is in minor units of currency
-- (paise for INR, kobo for NGN; USDC uses its 7 on-chain decimals). Positive in, negative out.
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  market_id text not null check (market_id in ('in', 'ng')),
  kind text not null,                      -- incoming, pay, save, group_contribution, advance, cash_in, ...
  source text,                             -- for incoming: state_transfer, wages, family_abroad, cash, deposit
  amount bigint not null,
  currency text not null check (currency in ('INR', 'NGN', 'USDC')),
  rail text not null check (rail in ('stellar', 'upi_sim', 'helper')),
  tx_hash text check (tx_hash ~ '^[0-9a-f]{64}$'),   -- saved before polling
  -- Every credit or debit carries a ref (payment reference, SEP-31 id, cash_event id or
  -- pending_action id); (rail, ref) is unique so a retried call can never apply twice.
  ref text not null check (ref <> ''),
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index transactions_user_created_idx on public.transactions (user_id, created_at desc);
create unique index transactions_rail_ref_key on public.transactions (rail, ref) where ref is not null;
create index transactions_tx_hash_idx on public.transactions (tx_hash) where tx_hash is not null;

create trigger transactions_updated_at before update on public.transactions
  for each row execute function public.set_updated_at();

alter table public.transactions enable row level security;
alter publication supabase_realtime add table public.transactions;
