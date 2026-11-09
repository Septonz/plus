-- groups.leader_helper_id: the helper who leads the group and may record cash for its members.
alter table public.groups
  add column leader_helper_id uuid references public.helpers (id) on delete set null;
create index groups_leader_helper_id_idx on public.groups (leader_helper_id);
