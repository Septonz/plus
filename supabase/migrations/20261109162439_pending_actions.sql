-- pending_actions: every money action is prepare -> confirm. confirm_action claims a row
-- with one atomic update (status pending -> executing) and returns the stored result on retries.
create table public.pending_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  kind text not null,
  params jsonb not null default '{}'::jsonb,
  readback text not null,                 -- what the agent reads aloud before the user confirms
  expires_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'executing', 'done', 'failed', 'expired')),
  result jsonb,
  created_by text not null default 'user' check (created_by in ('user', 'helper')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pending_actions_no_pin check (not (params ? 'pin'))
);

create index pending_actions_user_pending_idx on public.pending_actions (user_id, created_at desc)
  where status = 'pending';

create trigger pending_actions_updated_at before update on public.pending_actions
  for each row execute function public.set_updated_at();

alter table public.pending_actions enable row level security;
