-- Advisor fixes after own_row_policies and chain_worker_schedule:
-- 1. The RLS helper functions move to a private schema (not exposed through the Data API), so
--    signed-in users cannot call them as RPCs.
-- 2. One SELECT policy per table: "staff OR her own rows" (staff access unchanged), instead of two
--    permissive policies that Postgres would evaluate separately.
-- 3. pg_net moves out of public (its functions live in schema net either way).

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create or replace function private.current_plus_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$ select id from public.users where auth_user_id = (select auth.uid()) $$;

create or replace function private.current_plus_group_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.group_id from public.group_members m
   where m.user_id = (select id from public.users where auth_user_id = (select auth.uid()))
$$;

create or replace function private.is_staff()
returns boolean
language sql
stable
set search_path = ''
as $$ select coalesce((select auth.jwt() -> 'app_metadata' ->> 'role') = 'staff', false) $$;

revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;

-- users
drop policy users_own_read on public.users;
drop policy users_staff_read on public.users;
create policy users_read on public.users for select to authenticated
  using ((select private.is_staff()) or auth_user_id = (select auth.uid()));
-- sim_bank_accounts
drop policy sim_bank_accounts_own_read on public.sim_bank_accounts;
drop policy sim_bank_accounts_staff_read on public.sim_bank_accounts;
create policy sim_bank_accounts_read on public.sim_bank_accounts for select to authenticated
  using ((select private.is_staff()) or user_id = (select private.current_plus_user_id()));
-- transactions
drop policy transactions_own_read on public.transactions;
drop policy transactions_staff_read on public.transactions;
create policy transactions_read on public.transactions for select to authenticated
  using ((select private.is_staff()) or user_id = (select private.current_plus_user_id()));
-- pending_actions (no staff policy before; her own only)
drop policy pending_actions_own_read on public.pending_actions;
create policy pending_actions_read on public.pending_actions for select to authenticated
  using (user_id = (select private.current_plus_user_id()));
-- cash_events
drop policy cash_events_own_read on public.cash_events;
drop policy cash_events_staff_read on public.cash_events;
create policy cash_events_read on public.cash_events for select to authenticated
  using ((select private.is_staff()) or user_id = (select private.current_plus_user_id()));
-- groups
drop policy groups_own_read on public.groups;
drop policy groups_staff_read on public.groups;
create policy groups_read on public.groups for select to authenticated
  using ((select private.is_staff()) or id in (select private.current_plus_group_ids()));
-- group_members
drop policy group_members_own_read on public.group_members;
drop policy group_members_staff_read on public.group_members;
create policy group_members_read on public.group_members for select to authenticated
  using ((select private.is_staff()) or group_id in (select private.current_plus_group_ids()));
-- payees
drop policy payees_own_read on public.payees;
drop policy payees_staff_read on public.payees;
create policy payees_read on public.payees for select to authenticated
  using ((select private.is_staff()) or user_id = (select private.current_plus_user_id()));

drop function public.current_plus_user_id();
drop function public.current_plus_group_ids();

drop extension if exists pg_net;
create extension pg_net with schema extensions;
