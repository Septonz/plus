-- Prepare -> confirm, in the database. Edge Functions check the PIN and the voice/app rules,
-- then call these. Each runs in one transaction, so an action either fully happens or not at all.
--
-- execute_pending_action: claims the action with ONE atomic update (pending -> executing), runs
--   it through the sim_* functions (which also queue the on-chain record), and stores the result.
--   Any retry, including a concurrent one, gets the stored row back and changes nothing.
-- reject_pending_action: the user said No.
-- helper_record_cash_in: a helper records cash handed over; it counts only after the user's Yes.
-- expire_stale_actions: unanswered actions (and cash-ins, after 24 hours) expire.
-- Service role only.

create or replace function public.execute_pending_action(p_action_id uuid, p_user_id uuid)
returns public.pending_actions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.pending_actions;
  v_tx public.transactions;
  v_amount bigint;
  v_result jsonb;
begin
  -- Claim: one atomic update. A concurrent caller blocks on the row lock, then finds it claimed.
  update public.pending_actions set status = 'executing'
   where id = p_action_id and user_id = p_user_id and status = 'pending' and expires_at > now()
  returning * into v_a;

  if not found then
    select * into v_a from public.pending_actions where id = p_action_id and user_id = p_user_id;
    if not found then
      raise exception 'action_not_found' using errcode = 'P0002';
    end if;
    if v_a.status = 'pending' then   -- still pending, so it has expired
      update public.pending_actions
         set status = 'expired', result = jsonb_build_object('ok', false, 'error', 'expired')
       where id = v_a.id
      returning * into v_a;
      update public.cash_events set status = 'expired'
       where pending_action_id = v_a.id and status = 'awaiting_user';
    end if;
    return v_a;   -- the stored result: nothing runs twice
  end if;

  v_amount := (v_a.params ->> 'amount')::bigint;
  begin
    case v_a.kind
      when 'pay' then
        v_tx := public.sim_debit(p_user_id, v_amount, 'pay', 'action:' || v_a.id);
        v_result := jsonb_build_object('ok', true, 'transaction_id', v_tx.id, 'amount', v_amount,
                                       'payee_name', v_a.params ->> 'payee_name');
      when 'group_contribution' then
        v_tx := public.sim_debit(p_user_id, v_amount, 'group_contribution', 'action:' || v_a.id,
                                 (v_a.params ->> 'group_id')::uuid);
        v_result := jsonb_build_object('ok', true, 'transaction_id', v_tx.id, 'amount', v_amount,
                                       'group_id', v_a.params ->> 'group_id');
      when 'set_auto_save' then
        update public.users set auto_save_bps = (v_a.params ->> 'bps')::integer where id = p_user_id;
        v_result := jsonb_build_object('ok', true, 'bps', (v_a.params ->> 'bps')::integer);
      when 'confirm_cash_in' then
        update public.cash_events set status = 'confirmed'
         where id = (v_a.params ->> 'cash_event_id')::uuid and user_id = p_user_id and status = 'awaiting_user';
        if not found then
          raise exception 'cash_in_not_awaiting' using errcode = 'P0001';
        end if;
        v_tx := public.sim_credit(p_user_id, v_amount, 'cash', v_a.params ->> 'cash_event_id');
        update public.cash_events set rail_ref = v_tx.id::text where id = (v_a.params ->> 'cash_event_id')::uuid;
        v_result := jsonb_build_object('ok', true, 'transaction_id', v_tx.id, 'amount', v_amount,
                                       'helper_name', v_a.params ->> 'helper_name');
      else
        raise exception 'unknown_action_kind' using errcode = 'P0001';
    end case;

    update public.pending_actions set status = 'done', result = v_result where id = v_a.id
    returning * into v_a;
  exception when sqlstate 'P0001' then
    -- Expected refusals (insufficient_funds, not_member, ...): the money part is rolled back,
    -- the claim stays, and the refusal is stored as the result.
    update public.pending_actions
       set status = 'failed', result = jsonb_build_object('ok', false, 'error', sqlerrm)
     where id = v_a.id
    returning * into v_a;
  end;
  return v_a;
end;
$$;

create or replace function public.reject_pending_action(p_action_id uuid, p_user_id uuid)
returns public.pending_actions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.pending_actions;
begin
  update public.pending_actions
     set status = 'rejected', result = jsonb_build_object('ok', true, 'rejected', true)
   where id = p_action_id and user_id = p_user_id and status = 'pending'
  returning * into v_a;
  if not found then
    select * into v_a from public.pending_actions where id = p_action_id and user_id = p_user_id;
    if not found then
      raise exception 'action_not_found' using errcode = 'P0002';
    end if;
    return v_a;
  end if;
  if v_a.kind = 'confirm_cash_in' then
    update public.cash_events set status = 'rejected'
     where id = (v_a.params ->> 'cash_event_id')::uuid and status = 'awaiting_user';
  end if;
  return v_a;
end;
$$;

create or replace function public.helper_record_cash_in(
  p_helper_id uuid, p_user_id uuid, p_amount bigint, p_idempotency_key text, p_readback text)
returns public.cash_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h public.helpers;
  v_ce public.cash_events;
  v_used bigint;
  v_day_start timestamptz;
  v_pa_id uuid := gen_random_uuid();
  v_ce_id uuid := gen_random_uuid();
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if p_idempotency_key is null or p_idempotency_key = '' then
    raise exception 'missing_idempotency_key' using errcode = '22023';
  end if;

  -- Lock the helper: one record at a time per helper keeps the daily total exact.
  select * into v_h from public.helpers where id = p_helper_id for update;
  if not found or not v_h.active then
    raise exception 'helper_inactive' using errcode = 'P0001';
  end if;

  select * into v_ce from public.cash_events where helper_id = p_helper_id and idempotency_key = p_idempotency_key;
  if found then
    return v_ce;   -- retried call: same event
  end if;

  if not exists (
    select 1 from public.group_members m join public.groups g on g.id = m.group_id
     where g.leader_helper_id = p_helper_id and m.user_id = p_user_id
  ) then
    raise exception 'not_your_member' using errcode = 'P0001';
  end if;

  -- The helper's day, in the market's time zone.
  v_day_start := date_trunc('day', now() at time zone
                   case v_h.market_id when 'in' then 'Asia/Kolkata' else 'Africa/Lagos' end)
                 at time zone case v_h.market_id when 'in' then 'Asia/Kolkata' else 'Africa/Lagos' end;
  select coalesce(sum(amount), 0) into v_used from public.cash_events
   where helper_id = p_helper_id and created_at >= v_day_start and status in ('awaiting_user', 'confirmed');
  if v_used + p_amount > v_h.daily_limit then
    raise exception 'daily_limit_exceeded' using errcode = 'P0001',
      detail = format('used %s, limit %s, asked %s', v_used, v_h.daily_limit, p_amount);
  end if;

  insert into public.pending_actions (id, user_id, kind, params, readback, expires_at, created_by)
  values (v_pa_id, p_user_id, 'confirm_cash_in',
          jsonb_build_object('cash_event_id', v_ce_id, 'amount', p_amount, 'helper_id', p_helper_id,
                             'helper_name', v_h.name),
          p_readback, now() + interval '24 hours', 'helper');

  insert into public.cash_events (id, helper_id, user_id, direction, amount, status, pending_action_id, idempotency_key)
  values (v_ce_id, p_helper_id, p_user_id, 'in', p_amount, 'awaiting_user', v_pa_id, p_idempotency_key)
  returning * into v_ce;
  return v_ce;
end;
$$;

create or replace function public.expire_stale_actions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with expired as (
    update public.pending_actions
       set status = 'expired', result = jsonb_build_object('ok', false, 'error', 'expired')
     where status = 'pending' and expires_at <= now()
    returning id
  ), cash as (
    update public.cash_events set status = 'expired'
     where status = 'awaiting_user' and pending_action_id in (select id from expired)
    returning id
  )
  select count(*) into v_count from expired;
  return v_count;
end;
$$;

revoke execute on function public.execute_pending_action(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.reject_pending_action(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.helper_record_cash_in(uuid, uuid, bigint, text, text) from public, anon, authenticated;
revoke execute on function public.expire_stale_actions() from public, anon, authenticated;
grant execute on function public.execute_pending_action(uuid, uuid) to service_role;
grant execute on function public.reject_pending_action(uuid, uuid) to service_role;
grant execute on function public.helper_record_cash_in(uuid, uuid, bigint, text, text) to service_role;
grant execute on function public.expire_stale_actions() to service_role;
