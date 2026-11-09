-- remittances: SEP-31 transfers from family abroad, credited in INR to the user's bank.
create table public.remittances (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.senders (id) on delete restrict,
  user_id uuid not null references public.users (id) on delete cascade,
  cad_amount bigint not null check (cad_amount > 0),     -- cents
  quote jsonb,                                            -- SEP-38 quote as returned
  sep31_id text unique,
  status text not null default 'pending_sender',          -- SEP-31 status names
  inr_credited bigint check (inr_credited >= 0),          -- paise, once paid out
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index remittances_user_created_idx on public.remittances (user_id, created_at desc);
create index remittances_sender_id_idx on public.remittances (sender_id);

create trigger remittances_updated_at before update on public.remittances
  for each row execute function public.set_updated_at();

alter table public.remittances enable row level security;
alter publication supabase_realtime add table public.remittances;
