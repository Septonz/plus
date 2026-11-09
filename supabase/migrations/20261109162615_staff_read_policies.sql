-- Dashboard reads: signed-in staff (JWT app_metadata.role = 'staff') may select these tables.
-- app_metadata is set only with the service role, so users cannot grant themselves staff.
-- No policies on user_credentials, pending_actions or tool_calls (service role only).
-- (select auth.jwt()) is evaluated once per query, not once per row.

create policy users_staff_read on public.users
  for select to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'staff');
create policy helpers_staff_read on public.helpers
  for select to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'staff');
create policy sim_bank_accounts_staff_read on public.sim_bank_accounts
  for select to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'staff');
create policy transactions_staff_read on public.transactions
  for select to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'staff');
create policy cash_events_staff_read on public.cash_events
  for select to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'staff');
create policy remittances_staff_read on public.remittances
  for select to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'staff');
create policy groups_staff_read on public.groups
  for select to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'staff');
create policy group_members_staff_read on public.group_members
  for select to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'staff');
create policy chain_events_staff_read on public.chain_events
  for select to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'staff');
create policy payees_staff_read on public.payees
  for select to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'staff');
