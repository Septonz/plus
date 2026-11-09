-- Advisor fix (auth_rls_initplan): wrap auth.jwt() itself in a subselect so it is an initplan.
alter policy users_staff_read on public.users using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'staff');
alter policy helpers_staff_read on public.helpers using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'staff');
alter policy sim_bank_accounts_staff_read on public.sim_bank_accounts using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'staff');
alter policy transactions_staff_read on public.transactions using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'staff');
alter policy cash_events_staff_read on public.cash_events using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'staff');
alter policy remittances_staff_read on public.remittances using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'staff');
alter policy groups_staff_read on public.groups using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'staff');
alter policy group_members_staff_read on public.group_members using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'staff');
alter policy chain_events_staff_read on public.chain_events using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'staff');
alter policy payees_staff_read on public.payees using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'staff');
