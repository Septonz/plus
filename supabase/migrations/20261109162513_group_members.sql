-- group_members: a member is a Plus user, an on-chain ref (India: user_ref hex; Nigeria: G-address), or both.
create table public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid references public.users (id) on delete set null,
  member_ref text,
  name text,                               -- display name for voice ("Lakshmi")
  position smallint not null check (position >= 0),   -- payout order
  created_at timestamptz not null default now(),
  constraint group_members_identity check (user_id is not null or member_ref is not null),
  unique (group_id, position),
  unique (group_id, member_ref)
);

create index group_members_user_id_idx on public.group_members (user_id);

alter table public.group_members enable row level security;
