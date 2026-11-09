-- Tests for sim_credit, sim_debit and sim_move_to_savings.
-- Runs in a transaction and rolls back, so it leaves no data behind.
-- Run with the Supabase MCP execute_sql tool, or: psql "$DATABASE_URL" -f supabase/tests/sim_money.test.sql
-- Any failed assertion raises an error; success ends with the row "sim_money: all tests passed".
begin;

do $$
declare
  u uuid;
  t1 public.transactions;
  t2 public.transactions;
  bal bigint;
  sav bigint;
  n int;
  refused boolean;
begin
  insert into public.users (market_id, wa_phone, language, auto_save_bps)
  values ('in', '+910000099999', 'ta', 1000) returning id into u;
  insert into public.sim_bank_accounts (user_id, bank_name) values (u, 'Test Bank');

  -- credit with 10% auto-save
  t1 := public.sim_credit(u, 100000, 'wages', 'test:credit:1');
  select balance_paise, savings_paise into bal, sav from public.sim_bank_accounts where user_id = u;
  assert bal = 90000 and sav = 10000, format('credit: got balance %s savings %s', bal, sav);
  select count(*) into n from public.transactions where user_id = u;
  assert n = 2, format('credit should insert incoming + saved rows, got %s', n);
  assert exists (select 1 from public.transactions where ref = 'test:credit:1:save' and amount = -10000 and kind = 'saved'),
    'auto-save row missing';

  -- repeated credit ref changes nothing and returns the same row
  t2 := public.sim_credit(u, 100000, 'wages', 'test:credit:1');
  assert t2.id = t1.id, 'repeated credit returned a different row';
  select balance_paise, savings_paise into bal, sav from public.sim_bank_accounts where user_id = u;
  assert bal = 90000 and sav = 10000, format('repeated credit changed balances: %s / %s', bal, sav);
  select count(*) into n from public.transactions where user_id = u;
  assert n = 2, format('repeated credit inserted rows: %s', n);

  -- debit, then the same ref again
  t1 := public.sim_debit(u, 50000, 'pay', 'test:debit:1');
  t2 := public.sim_debit(u, 50000, 'pay', 'test:debit:1');
  assert t2.id = t1.id, 'repeated debit returned a different row';
  select balance_paise into bal from public.sim_bank_accounts where user_id = u;
  assert bal = 40000, format('debit: got balance %s', bal);

  -- overdraft is refused and changes nothing
  refused := false;
  begin
    perform public.sim_debit(u, 40001, 'pay', 'test:debit:2');
  exception when others then
    assert sqlerrm = 'insufficient_funds', format('unexpected error: %s', sqlerrm);
    refused := true;
  end;
  assert refused, 'overdraft debit was not refused';
  select balance_paise into bal from public.sim_bank_accounts where user_id = u;
  assert bal = 40000, format('overdraft changed balance: %s', bal);
  assert not exists (select 1 from public.transactions where ref = 'test:debit:2'), 'overdraft inserted a row';

  -- move to savings, repeated
  perform public.sim_move_to_savings(u, 10000, 'test:save:1');
  perform public.sim_move_to_savings(u, 10000, 'test:save:1');
  select balance_paise, savings_paise into bal, sav from public.sim_bank_accounts where user_id = u;
  assert bal = 30000 and sav = 20000, format('move to savings: got %s / %s', bal, sav);

  refused := false;
  begin
    perform public.sim_move_to_savings(u, 30001, 'test:save:2');
  exception when others then
    assert sqlerrm = 'insufficient_funds', format('unexpected error: %s', sqlerrm);
    refused := true;
  end;
  assert refused, 'overdraft move to savings was not refused';

  -- missing ref is refused
  refused := false;
  begin
    perform public.sim_credit(u, 100, 'wages', '');
  exception when others then
    refused := sqlerrm = 'missing_ref';
  end;
  assert refused, 'empty ref was not refused';

  -- only service_role may execute
  assert not has_function_privilege('anon', 'public.sim_credit(uuid, bigint, text, text)', 'execute'), 'anon can execute sim_credit';
  assert not has_function_privilege('authenticated', 'public.sim_debit(uuid, bigint, text, text)', 'execute'), 'authenticated can execute sim_debit';
  assert not has_function_privilege('anon', 'public.sim_move_to_savings(uuid, bigint, text)', 'execute'), 'anon can execute sim_move_to_savings';
  assert has_function_privilege('service_role', 'public.sim_credit(uuid, bigint, text, text)', 'execute'), 'service_role cannot execute sim_credit';
end;
$$;

select 'sim_money: all tests passed' as result;

rollback;
