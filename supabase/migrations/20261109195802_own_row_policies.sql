-- App reads: a signed-in user may select only her own rows, matched through users.auth_user_id.
-- Realtime (postgres_changes) applies the same policies, so she only receives her own changes.
-- Staff policies stay. Writes still go only through Edge Functions (service role).
-- Helpers are security definer so the policies don't recurse through RLS; (select ...) makes
-- Postgres evaluate them once per query, not once per row.

create or replace function public.current_plus_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$ select id from public.users where auth_user_id = (select auth.uid()) $$;

create or replace function public.current_plus_group_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.group_id from public.group_members m
   where m.user_id = (select id from public.users where auth_user_id = (select auth.uid()))
$$;

revoke execute on function public.current_plus_user_id() from public, anon;
revoke execute on function public.current_plus_group_ids() from public, anon;
grant execute on function public.current_plus_user_id() to authenticated, service_role;
grant execute on function public.current_plus_group_ids() to authenticated, service_role;

create policy users_own_read on public.users
  for select to authenticated using (auth_user_id = (select auth.uid()));
create policy sim_bank_accounts_own_read on public.sim_bank_accounts
  for select to authenticated using (user_id = (select public.current_plus_user_id()));
create policy transactions_own_read on public.transactions
  for select to authenticated using (user_id = (select public.current_plus_user_id()));
create policy pending_actions_own_read on public.pending_actions
  for select to authenticated using (user_id = (select public.current_plus_user_id()));
create policy cash_events_own_read on public.cash_events
  for select to authenticated using (user_id = (select public.current_plus_user_id()));
-- Her groups, and every member of her groups (names and positions, for the seettu screen).
create policy groups_own_read on public.groups
  for select to authenticated using (id in (select public.current_plus_group_ids()));
create policy group_members_own_read on public.group_members
  for select to authenticated using (group_id in (select public.current_plus_group_ids()));
-- Her saved payees (the Pay screen's big buttons).
create policy payees_own_read on public.payees
  for select to authenticated using (user_id = (select public.current_plus_user_id()));

-- transactions, cash_events and payees already have indexes led by user_id.
create index if not exists pending_actions_user_id_idx on public.pending_actions (user_id);
