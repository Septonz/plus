-- Tests for the outbox rows written by sim_*, execute_pending_action (idempotent claim),
-- reject_pending_action, helper_record_cash_in (daily limit, idempotency) and expiry.
-- Runs in a transaction and rolls back. Run with the Supabase MCP execute_sql tool, or:
--   psql "$DATABASE_URL" -f supabase/tests/actions.test.sql
-- Success ends with the row "actions: all tests passed".
begin;

do $$
declare
  u uuid;
  other uuid;
  h uuid;
  g uuid;
  a public.pending_actions;
  a2 public.pending_actions;
  ce public.cash_events;
  ce2 public.cash_events;
  bal bigint;
  sav bigint;
  n int;
  refused boolean;
  ref_hex text := repeat('ab', 32);
begin
  insert into public.users (market_id, wa_phone, language, auto_save_bps, ref_hash)
  values ('in', '+910000099998', 'ta', 1000, ref_hex) returning id into u;
  insert into public.users (market_id, wa_phone, language) values ('in', '+910000099997', 'ta') returning id into other;
  insert into public.sim_bank_accounts (user_id, bank_name) values (u, 'Test Bank'), (other, 'Test Bank');
  insert into public.helpers (market_id, name, phone, role, daily_limit)
  values ('in', 'Test Helper', '+910000099996', 'group_leader', 100000) returning id into h;
  insert into public.groups (market_id, name, mode, onchain_id, amount, period_secs, leader_helper_id)
  values ('in', 'test seettu', 'record', 999999, 20000, 2592000, h) returning id into g;
  insert into public.group_members (group_id, user_id, member_ref, name, position) values (g, u, ref_hex, 'U', 0);

  -- sim_credit queues attest received + attest saved, once
  perform public.sim_credit(u, 100000, 'wages', 'test:a:credit');
  perform public.sim_credit(u, 100000, 'wages', 'test:a:credit');
  select count(*) into n from public.chain_outbox where ref like 'attest:upi_sim:test:a:credit%';
  assert n = 2, format('credit should queue 2 attests, got %s', n);
  assert exists (select 1 from public.chain_outbox where ref = 'attest:upi_sim:test:a:credit'
                   and args ->> 'kind' = 'received' and args ->> 'amount' = '10000000000'
                   and args ->> 'user_ref' = ref_hex and status = 'queued'), 'received attest args wrong';
  -- a user without an on-chain ref gets money but no outbox rows
  perform public.sim_credit(other, 5000, 'wages', 'test:a:other');
  assert not exists (select 1 from public.chain_outbox where ref like '%test:a:other%'), 'no-ref user queued an attest';

  -- pay: execute twice -> one debit, one outbox row, same stored result
  insert into public.pending_actions (user_id, kind, params, readback, expires_at)
  values (u, 'pay', '{"amount": 30000, "payee_name": "flower wholesaler"}', 'Rs 300 to flower wholesaler', now() + interval '10 minutes')
  returning * into a;
  a := public.execute_pending_action(a.id, u);
  assert a.status = 'done' and (a.result ->> 'ok')::boolean, format('pay not done: %s %s', a.status, a.result);
  a2 := public.execute_pending_action(a.id, u);
  assert a2.result = a.result and a2.status = 'done', 'retry returned a different result';
  select balance_paise into bal from public.sim_bank_accounts where user_id = u;
  assert bal = 90000 - 30000, format('pay applied wrong amount or twice: balance %s', bal);
  select count(*) into n from public.chain_outbox where ref = 'attest:upi_sim:action:' || a.id;
  assert n = 1, 'pay should queue one paid attest';

  -- another user cannot execute it
  refused := false;
  begin
    perform public.execute_pending_action(a.id, other);
  exception when sqlstate 'P0002' then refused := true;
  end;
  assert refused, 'another user could see the action';

  -- overdraft fails cleanly and stores the refusal
  insert into public.pending_actions (user_id, kind, params, readback, expires_at)
  values (u, 'pay', '{"amount": 99999999, "payee_name": "x"}', 'too much', now() + interval '10 minutes')
  returning * into a;
  a := public.execute_pending_action(a.id, u);
  assert a.status = 'failed' and a.result ->> 'error' = 'insufficient_funds', format('overdraft: %s %s', a.status, a.result);
  select balance_paise into bal from public.sim_bank_accounts where user_id = u;
  assert bal = 60000, 'failed pay changed the balance';

  -- group contribution queues a group_record with the member ref
  insert into public.pending_actions (user_id, kind, params, readback, expires_at)
  values (u, 'group_contribution', jsonb_build_object('amount', 20000, 'group_id', g), 'seettu', now() + interval '10 minutes')
  returning * into a;
  a := public.execute_pending_action(a.id, u);
  assert a.status = 'done', format('contribution: %s %s', a.status, a.result);
  assert exists (select 1 from public.chain_outbox where kind = 'group_record' and (args ->> 'group_id')::bigint = 999999
                   and args ->> 'member_ref' = ref_hex), 'group_record not queued';

  -- expired actions do not run
  insert into public.pending_actions (user_id, kind, params, readback, expires_at)
  values (u, 'pay', '{"amount": 100, "payee_name": "x"}', 'late', now() - interval '1 second')
  returning * into a;
  a := public.execute_pending_action(a.id, u);
  assert a.status = 'expired', format('expired action ran: %s', a.status);

  -- helper cash-in: awaiting until confirmed; idempotent; daily limit enforced
  ce := public.helper_record_cash_in(h, u, 50000, 'idem-1', 'Test Helper says you gave Rs 500');
  ce2 := public.helper_record_cash_in(h, u, 50000, 'idem-1', 'Test Helper says you gave Rs 500');
  assert ce.id = ce2.id and ce.status = 'awaiting_user', 'helper retry created a second event';
  select balance_paise into bal from public.sim_bank_accounts where user_id = u;
  assert bal = 40000, 'cash-in changed the balance before the user confirmed';
  refused := false;
  begin
    perform public.helper_record_cash_in(h, u, 50001, 'idem-2', 'over');
  exception when sqlstate 'P0001' then refused := sqlerrm = 'daily_limit_exceeded';
  end;
  assert refused, 'daily limit not enforced';
  refused := false;
  begin
    perform public.helper_record_cash_in(h, other, 100, 'idem-3', 'not in group');
  exception when sqlstate 'P0001' then refused := sqlerrm = 'not_your_member';
  end;
  assert refused, 'helper recorded cash for someone outside her group';

  -- the user says Yes: credited with source cash (auto-save applies)
  a := public.execute_pending_action(ce.pending_action_id, u);
  assert a.status = 'done', format('cash-in confirm: %s %s', a.status, a.result);
  select status into ce2.status from public.cash_events where id = ce.id;
  assert ce2.status = 'confirmed', 'cash event not confirmed';
  select balance_paise, savings_paise into bal, sav from public.sim_bank_accounts where user_id = u;
  assert bal = 40000 + 45000, format('cash-in credit wrong: %s', bal);

  -- a second cash-in, rejected: no money moves, event rejected, confirm afterwards does nothing
  ce := public.helper_record_cash_in(h, u, 10000, 'idem-4', 'Rs 100');
  a := public.reject_pending_action(ce.pending_action_id, u);
  assert a.status = 'rejected', 'reject failed';
  select status into ce2.status from public.cash_events where id = ce.id;
  assert ce2.status = 'rejected', 'cash event not rejected';
  a := public.execute_pending_action(ce.pending_action_id, u);
  assert a.status = 'rejected', 'confirm after reject ran';
  select balance_paise into bal from public.sim_bank_accounts where user_id = u;
  assert bal = 85000, 'rejected cash-in moved money';
  -- rejected cash no longer counts toward the helper's day: 50,000 used of 100,000
  ce := public.helper_record_cash_in(h, u, 50000, 'idem-5', 'Rs 500');
  assert ce.status = 'awaiting_user', 'limit counted a rejected cash-in';

  -- expiry job: old cash-ins expire after 24 hours
  update public.pending_actions set expires_at = now() - interval '1 second' where id = ce.pending_action_id;
  perform public.expire_stale_actions();
  select status into ce2.status from public.cash_events where id = ce.id;
  assert ce2.status = 'expired', 'stale cash-in did not expire';

  -- privileges
  assert not has_function_privilege('authenticated', 'public.execute_pending_action(uuid, uuid)', 'execute'), 'authenticated can execute actions';
  assert not has_function_privilege('anon', 'public.helper_record_cash_in(uuid, uuid, bigint, text, text)', 'execute'), 'anon can record cash';
  assert not has_table_privilege('authenticated', 'public.chain_outbox', 'select'), 'authenticated can read the outbox';
end $$;

select 'actions: all tests passed' as result;
rollback;
