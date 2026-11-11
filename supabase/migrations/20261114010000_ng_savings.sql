-- Piece 11: Savings in Nigeria, on Stellar.
--
-- Her savings goal is a pot on the plus contract: pot_create(sender = her, payout_to = her, NGNT,
-- per_period = the goal, period_secs = 0: manual only). pot_fund saves, pot_send takes out (back
-- to her wallet), all signed by her own key through the chain outbox. The contract holds the money,
-- out of daily spending; only she can move it.
--
-- Auto-save: on every money-in, the loan's share is repaid first, then auto_save_bps of the rest
-- goes to the pot (after the money has landed). Savings deposits count toward the lending model's
-- savings consistency next to ajo payments.

create table public.savings_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  goal bigint not null check (goal > 0),           -- kobo
  onchain_pot_id integer,                           -- set once pot_create is on Stellar
  create_outbox_id bigint,
  status text not null default 'active' check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index savings_goals_one_active on public.savings_goals (user_id) where status = 'active';
alter table public.savings_goals enable row level security;
create policy savings_goals_own on public.savings_goals
  for select to authenticated using ((select private.is_staff()) or user_id = (select private.current_plus_user_id()));

-- Demo history: earlier weeks' savings deposits (the lending model's "saved in N of 8 weeks").
alter table public.credit_history_seed add column if not exists savings bigint not null default 0;

-- What she has saved, by Plus's ledger (the app also reads the pot's balance from the contract).
create or replace function public.ng_savings_balance(p_user_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(-amount), 0)::bigint
    from public.transactions
   where user_id = p_user_id and status <> 'failed' and kind in ('saved', 'savings_out') and rail = 'stellar';
$$;
revoke execute on function public.ng_savings_balance(uuid) from public, anon, authenticated;
grant execute on function public.ng_savings_balance(uuid) to service_role;

-- Money on its way out counts against what she can spend (now also savings and bank sends).
create or replace function public.ng_available(p_user_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select amount from public.wallet_balances where user_id = p_user_id and asset = 'NGNT'), 0)
       - coalesce((select sum(-amount) from public.transactions
                    where user_id = p_user_id and status = 'pending' and rail = 'stellar'
                      and kind in ('pay', 'group_contribution', 'cash_out', 'repay', 'loan_repay', 'bank_send', 'saved')), 0);
$$;

-- Set (or rename) her goal. The first time, her pot is created on Stellar.
create or replace function public.ng_savings_goal_set(p_user_id uuid, p_name text, p_goal bigint, p_asset_sac text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_u public.users;
  v_g public.savings_goals;
  v_signer text;
begin
  if p_goal is null or p_goal <= 0 or coalesce(btrim(p_name), '') = '' then
    raise exception 'invalid_goal' using errcode = 'P0001';
  end if;
  select * into v_u from public.users where id = p_user_id;
  v_signer := public.signer_of(v_u.secret_name);
  if v_u.market_id <> 'ng' or v_u.stellar_pub is null or v_signer is null then
    raise exception 'no_wallet' using errcode = 'P0001';
  end if;
  update public.savings_goals set name = left(btrim(p_name), 60), goal = p_goal, updated_at = now()
   where user_id = p_user_id and status = 'active'
  returning * into v_g;
  if found then
    return to_jsonb(v_g) || jsonb_build_object('created', false);
  end if;
  insert into public.savings_goals (user_id, name, goal) values (p_user_id, left(btrim(p_name), 60), p_goal) returning * into v_g;
  update public.savings_goals set create_outbox_id = public.chain_enqueue_on(v_signer, 'contract', 'pot_create:' || v_g.id, jsonb_build_object(
    'fn', 'pot_create',
    'args', jsonb_build_array(jsonb_build_object('t', 'address', 'v', v_u.stellar_pub),
                              jsonb_build_object('t', 'address', 'v', v_u.stellar_pub),
                              jsonb_build_object('t', 'address', 'v', p_asset_sac),
                              jsonb_build_object('t', 'i128', 'v', (p_goal * 100000)::text),
                              jsonb_build_object('t', 'u64', 'v', '0')),
    'savings_goal_id', v_g.id))
   where id = v_g.id returning * into v_g;
  return to_jsonb(v_g) || jsonb_build_object('created', true);
end;
$$;
revoke execute on function public.ng_savings_goal_set(uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.ng_savings_goal_set(uuid, text, bigint, text) to service_role;

-- The pot's id: from the worker's record of pot_create's return value, or from the synced
-- pot_created event (whichever comes first).
create or replace function private.savings_pot_from_outbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.result ? 'returned' then
    update public.savings_goals set onchain_pot_id = (new.result ->> 'returned')::integer, updated_at = now()
     where id = (new.args ->> 'savings_goal_id')::uuid and onchain_pot_id is null;
  end if;
  return new;
end;
$$;
revoke execute on function private.savings_pot_from_outbox() from public, anon, authenticated;
create trigger chain_outbox_savings_pot after update of status on public.chain_outbox
  for each row when (new.status = 'done' and old.status is distinct from 'done' and new.args ? 'savings_goal_id')
  execute function private.savings_pot_from_outbox();

create or replace function private.savings_pot_from_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.savings_goals g set onchain_pot_id = (new.topics ->> 1)::integer, updated_at = now()
    from public.users u
   where u.id = g.user_id and g.status = 'active' and g.onchain_pot_id is null
     and u.stellar_pub = new.data ->> 'sender' and u.stellar_pub = new.data ->> 'payout_to';
  return new;
end;
$$;
revoke execute on function private.savings_pot_from_event() from public, anon, authenticated;
create trigger chain_events_savings_pot after insert on public.chain_events
  for each row when (new.type = 'pot_created') execute function private.savings_pot_from_event();

-- Auto-save from a money-in: auto_save_bps of what is left after the loan's share, into her pot
-- once the money has landed (p_after). Only when she has a goal on Stellar. Returns the row, or null.
create or replace function public.ng_auto_save(p_user_id uuid, p_base bigint, p_ref text, p_after bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_u public.users;
  v_g public.savings_goals;
  v_signer text;
  v_amount bigint;
  v_tx uuid;
begin
  select * into v_u from public.users where id = p_user_id;
  v_signer := public.signer_of(v_u.secret_name);
  if v_u.market_id <> 'ng' or v_signer is null or coalesce(v_u.auto_save_bps, 0) <= 0 or p_base is null or p_base <= 0 then
    return null;
  end if;
  select * into v_g from public.savings_goals where user_id = p_user_id and status = 'active' and onchain_pot_id is not null;
  if not found then
    return null;
  end if;
  v_amount := (p_base * v_u.auto_save_bps) / 10000;   -- integer division, rounds down
  if v_amount < 100 then                              -- under N1: not worth a transaction
    return null;
  end if;
  insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status, counterparty)
  values (p_user_id, 'ng', 'saved', 'auto_save', -v_amount, 'NGN', 'stellar', 'auto_save:' || p_ref, 'pending', v_g.name)
  on conflict (rail, ref) do nothing
  returning id into v_tx;
  if v_tx is null then
    return null;
  end if;
  perform public.chain_enqueue_on(v_signer, 'contract', 'auto_save:' || p_ref, jsonb_build_object(
    'fn', 'pot_fund',
    'args', jsonb_build_array(jsonb_build_object('t', 'address', 'v', v_u.stellar_pub),
                              jsonb_build_object('t', 'u32', 'v', v_g.onchain_pot_id),
                              jsonb_build_object('t', 'i128', 'v', (v_amount * 100000)::text)),
    'transaction_id', v_tx), p_after);
  return v_tx;
end;
$$;
revoke execute on function public.ng_auto_save(uuid, bigint, text, bigint) from public, anon, authenticated;

-- Every money-in: the loan's share first, then auto-save from the remainder.
create or replace function public.ng_loan_repay_from_money_in(p_user_id uuid, p_money_in bigint, p_ref text, p_after bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bps integer;
  v_loan_tx uuid;
  v_loan bigint := 0;
begin
  select repay_bps into v_bps from public.loans where user_id = p_user_id and status in ('active', 'late', 'restructured');
  if found and v_bps > 0 then
    v_loan_tx := public.ng_loan_repay(p_user_id, (p_money_in * v_bps) / 10000, p_ref, p_after, 'money_in');
    v_loan := coalesce((select -amount from public.transactions where id = v_loan_tx), 0);
  end if;
  perform public.ng_auto_save(p_user_id, p_money_in - v_loan, p_ref, p_after);
  return v_loan_tx;
end;
$$;
revoke execute on function public.ng_loan_repay_from_money_in(uuid, bigint, text, bigint) from public, anon, authenticated;

-- Her weeks: savings deposits count toward savings consistency (a column of their own, next to ajo).
drop function if exists public.ng_credit_weeks(uuid);
create function public.ng_credit_weeks(p_user_id uuid)
returns table (week integer, money_in bigint, qualifying_tx integer, saved bigint, savings bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with u as (select member_since from public.users where id = p_user_id),
  t as (
    select tx.*, (floor(extract(epoch from (tx.created_at - u.member_since)) / 604800))::integer + 1 as wk,
           exists (
             select 1 from public.transactions o
              where o.user_id = tx.user_id and o.status = 'completed' and o.source = 'plus_user'
                and o.counterparty = tx.counterparty and o.id <> tx.id
                and sign(o.amount) <> sign(tx.amount)
                and o.created_at between tx.created_at - interval '7 days' and tx.created_at + interval '7 days'
           ) as circular
      from public.transactions tx, u
     where tx.user_id = p_user_id and tx.status = 'completed'
       and tx.kind in ('incoming', 'pay', 'group_contribution', 'cash_out', 'saved')
  ),
  real as (
    select wk as week,
           coalesce(sum(amount) filter (where kind = 'incoming' and not circular), 0)::bigint as money_in,
           (count(*) filter (where not circular and kind <> 'saved'))::integer as qualifying_tx,
           coalesce(sum(-amount) filter (where kind = 'group_contribution'), 0)::bigint as saved,
           coalesce(sum(-amount) filter (where kind = 'saved'), 0)::bigint as savings
      from t where wk >= 1 group by wk
  )
  select week, sum(money_in)::bigint, sum(qualifying_tx)::integer, sum(saved)::bigint, sum(savings)::bigint
    from (select * from real
          union all
          select s.week_index, s.money_in, s.qualifying_tx, s.saved, s.savings from public.credit_history_seed s where s.user_id = p_user_id) w
   group by week order by week;
$$;
revoke execute on function public.ng_credit_weeks(uuid) from public, anon, authenticated;
grant execute on function public.ng_credit_weeks(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The action executor, with 'save' and 'savings_withdraw' (everything else as in piece 10).
-- ---------------------------------------------------------------------------
create or replace function public.ng_execute_pending_action(p_action_id uuid, p_user_id uuid, p_extra jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.pending_actions;
  v_u public.users;
  v_h public.helpers;
  v_peer public.users;
  v_tx public.transactions;
  v_peer_tx public.transactions;
  v_repay_tx public.transactions;
  v_loan public.loans;
  v_amount bigint;
  v_signer text;
  v_lend text;
  v_out bigint;
  v_out2 bigint;
  v_co uuid;
  v_repay bigint;
  v_id uuid;
  v_result jsonb;
  v_goal public.savings_goals;
begin
  update public.pending_actions set status = 'executing'
   where id = p_action_id and user_id = p_user_id and status = 'pending' and expires_at > now()
  returning * into v_a;

  if not found then
    select * into v_a from public.pending_actions where id = p_action_id and user_id = p_user_id;
    if not found then
      raise exception 'action_not_found' using errcode = 'P0002';
    end if;
    if v_a.status = 'pending' then
      update public.pending_actions
         set status = 'expired', result = jsonb_build_object('ok', false, 'error', 'expired')
       where id = v_a.id
      returning * into v_a;
      update public.cash_events set status = 'expired'
       where pending_action_id = v_a.id and status = 'awaiting_user';
    end if;
    return jsonb_build_object('action', to_jsonb(v_a), 'claimed', false);
  end if;

  select * into v_u from public.users where id = p_user_id;
  v_signer := public.signer_of(v_u.secret_name);
  v_amount := (v_a.params ->> 'amount')::bigint;

  begin
    if v_u.market_id <> 'ng' or v_u.stellar_pub is null or v_u.archived_at is not null
       or (v_signer is null and v_a.kind <> 'vouch') then
      raise exception 'no_wallet' using errcode = 'P0001';
    end if;
    if v_a.kind not in ('loan_extension', 'loan_restructure', 'record_share', 'vouch') and (v_amount is null or v_amount <= 0) then
      raise exception 'invalid_amount' using errcode = 'P0001';
    end if;

    -- Money leaving her wallet: she must have it now (cache minus what is already on its way).
    if v_a.kind in ('pay', 'pay_code', 'group_contribution', 'cash_out', 'loan_repay', 'bank_send', 'save') and public.ng_available(p_user_id) < v_amount then
      raise exception 'insufficient_funds' using errcode = 'P0001';
    end if;

    case v_a.kind
      when 'pay' then
        insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status, counterparty)
        values (p_user_id, 'ng', 'pay', case when v_a.params ? 'to_user_id' then 'plus_user' end, -v_amount, 'NGN', 'stellar',
                'action:' || v_a.id, 'pending', v_a.params ->> 'payee_name')
        returning * into v_tx;
        -- To another Plus user: her side of it, so it shows in what arrived (same Stellar transaction).
        if v_a.params ? 'to_user_id' then
          select * into v_peer from public.users where id = (v_a.params ->> 'to_user_id')::uuid;
          if not found or v_peer.stellar_pub is distinct from v_a.params ->> 'to' or v_peer.archived_at is not null then
            raise exception 'recipient_changed' using errcode = 'P0001';
          end if;
          insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status, counterparty)
          values (v_peer.id, 'ng', 'incoming', 'plus_user', v_amount, 'NGN', 'stellar', 'received:' || v_a.id, 'pending', v_u.name)
          returning * into v_peer_tx;
        end if;
        v_out := public.chain_enqueue_on(v_signer, 'payment', 'pay:' || v_a.id, jsonb_build_object(
          'asset', 'NGNT', 'to', v_a.params ->> 'to', 'amount', (v_amount * 100000)::text, 'transaction_id', v_tx.id,
          'peer_transaction_id', v_peer_tx.id));
        -- Their money-in repays their open loan (10%), after it lands.
        if v_peer_tx.id is not null then
          perform public.ng_loan_repay_from_money_in(v_peer.id, v_amount, 'received:' || v_a.id, v_out);
        end if;
        v_result := jsonb_build_object('payee_name', v_a.params ->> 'payee_name', 'to_plus_user', v_peer_tx.id is not null,
                                       'phone', v_a.params ->> 'phone');

      when 'pay_code' then
        if coalesce(p_extra ->> 'code_hash', '') !~ '^[0-9a-f]{64}$' then
          raise exception 'missing_code' using errcode = 'P0001';
        end if;
        insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status, counterparty)
        values (p_user_id, 'ng', 'pay', 'code', -v_amount, 'NGN', 'stellar', 'action:' || v_a.id, 'pending', v_a.params ->> 'payee_name')
        returning * into v_tx;
        v_out := public.chain_enqueue_on(v_signer, 'claimable_create', 'pay_code:' || v_a.id, jsonb_build_object(
          'asset', 'NGNT', 'amount', (v_amount * 100000)::text,
          'claimants', v_a.params -> 'claimants', 'owner', v_u.stellar_pub, 'return_after_secs', 604800,
          'transaction_id', v_tx.id));
        insert into public.cash_out_codes (user_id, action_id, amount, code_hash, create_outbox_id, expires_at, recipient_phone, recipient_name)
        values (p_user_id, v_a.id, v_amount, p_extra ->> 'code_hash', v_out, now() + interval '7 days',
                v_a.params ->> 'phone', v_a.params ->> 'payee_name')
        returning id into v_co;
        v_result := jsonb_build_object('cash_out_id', v_co, 'payee_name', v_a.params ->> 'payee_name', 'phone', v_a.params ->> 'phone');

      when 'group_contribution' then
        insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status)
        values (p_user_id, 'ng', 'group_contribution', v_a.params ->> 'group_id', -v_amount, 'NGN', 'stellar', 'action:' || v_a.id, 'pending')
        returning * into v_tx;
        v_out := public.chain_enqueue_on(v_signer, 'contract', 'group_contribute:' || v_a.id, jsonb_build_object(
          'fn', 'group_contribute',
          'args', jsonb_build_array(jsonb_build_object('t', 'address', 'v', v_u.stellar_pub),
                                    jsonb_build_object('t', 'u32', 'v', (v_a.params ->> 'onchain_id')::integer)),
          'transaction_id', v_tx.id));
        v_result := jsonb_build_object('group_name', v_a.params ->> 'group_name');

      when 'advance' then
        insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status)
        values (p_user_id, 'ng', 'advance', 'advance', v_amount, 'NGN', 'stellar', 'action:' || v_a.id, 'pending')
        returning * into v_tx;
        v_out := public.chain_enqueue_on(v_signer, 'contract', 'request_advance:' || v_a.id, jsonb_build_object(
          'fn', 'request_advance',
          'args', jsonb_build_array(jsonb_build_object('t', 'address', 'v', v_u.stellar_pub),
                                    jsonb_build_object('t', 'address', 'v', v_a.params ->> 'asset_sac'),
                                    jsonb_build_object('t', 'i128', 'v', (v_amount * 100000)::text)),
          'transaction_id', v_tx.id));
        v_result := jsonb_build_object('fee', (v_a.params ->> 'fee')::bigint);

      when 'cash_out' then
        if coalesce(p_extra ->> 'code_hash', '') !~ '^[0-9a-f]{64}$' then
          raise exception 'missing_code' using errcode = 'P0001';
        end if;
        insert into public.transactions (user_id, market_id, kind, amount, currency, rail, ref, status)
        values (p_user_id, 'ng', 'cash_out', -v_amount, 'NGN', 'stellar', 'action:' || v_a.id, 'pending')
        returning * into v_tx;
        v_out := public.chain_enqueue_on(v_signer, 'claimable_create', 'cash_out:' || v_a.id, jsonb_build_object(
          'asset', 'NGNT', 'amount', (v_amount * 100000)::text,
          'claimants', v_a.params -> 'claimants', 'owner', v_u.stellar_pub, 'return_after_secs', 604800,
          'transaction_id', v_tx.id));
        insert into public.cash_out_codes (user_id, action_id, amount, code_hash, create_outbox_id, expires_at)
        values (p_user_id, v_a.id, v_amount, p_extra ->> 'code_hash', v_out, now() + interval '7 days')
        returning id into v_co;
        v_result := jsonb_build_object('cash_out_id', v_co);

      when 'confirm_cash_in' then
        update public.cash_events set status = 'confirmed'
         where id = (v_a.params ->> 'cash_event_id')::uuid and user_id = p_user_id and status = 'awaiting_user';
        if not found then
          raise exception 'cash_in_not_awaiting' using errcode = 'P0001';
        end if;
        select * into v_h from public.helpers where id = (v_a.params ->> 'helper_id')::uuid;
        if public.signer_of(v_h.secret_name) is null then
          raise exception 'agent_has_no_wallet' using errcode = 'P0001';
        end if;
        insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status, counterparty)
        values (p_user_id, 'ng', 'incoming', 'cash', v_amount, 'NGN', 'stellar', 'cash_in:' || (v_a.params ->> 'cash_event_id'), 'pending', v_h.name)
        returning * into v_tx;
        v_out := public.chain_enqueue_on(public.signer_of(v_h.secret_name), 'payment', 'cash_in:' || (v_a.params ->> 'cash_event_id'),
          jsonb_build_object('asset', 'NGNT', 'to', v_u.stellar_pub, 'amount', (v_amount * 100000)::text, 'transaction_id', v_tx.id));
        update public.cash_events set rail_ref = v_tx.id::text where id = (v_a.params ->> 'cash_event_id')::uuid;
        v_repay := least(coalesce((p_extra ->> 'repay')::bigint, 0), v_amount);
        if v_repay > 0 then
          insert into public.transactions (user_id, market_id, kind, amount, currency, rail, ref, status)
          values (p_user_id, 'ng', 'repay', -v_repay, 'NGN', 'stellar', 'repay:' || (v_a.params ->> 'cash_event_id'), 'pending')
          returning * into v_repay_tx;
          v_out2 := public.chain_enqueue_on(v_signer, 'contract', 'repay:' || (v_a.params ->> 'cash_event_id'), jsonb_build_object(
            'fn', 'repay',
            'args', jsonb_build_array(jsonb_build_object('t', 'address', 'v', v_u.stellar_pub),
                                      jsonb_build_object('t', 'i128', 'v', (v_repay * 100000)::text)),
            'transaction_id', v_repay_tx.id), v_out);
        end if;
        v_id := public.ng_loan_repay_from_money_in(p_user_id, v_amount, 'cash_in:' || (v_a.params ->> 'cash_event_id'), v_out);
        v_result := jsonb_build_object('helper_name', v_a.params ->> 'helper_name', 'repay', coalesce(v_repay, 0),
                                       'repay_transaction_id', v_repay_tx.id, 'loan_repay_transaction_id', v_id,
                                       'loan_repay', coalesce((select -amount from public.transactions where id = v_id), 0));

      when 'loan' then
        if exists (select 1 from public.loans where user_id = p_user_id and status in ('active', 'late', 'restructured')) then
          raise exception 'loan_open' using errcode = 'P0001';
        end if;
        if v_u.borrowing_frozen_until > now() then
          raise exception 'borrowing_frozen' using errcode = 'P0001';
        end if;
        -- Piece 10: an offer that counted on vouches needs them still there (one may have been withdrawn).
        if coalesce((v_a.params ->> 'vouches_needed')::integer, 0) > 0
           and (select count(*) from public.vouches where borrower_user_id = p_user_id and status = 'active')
               < (v_a.params ->> 'vouches_needed')::integer then
          raise exception 'vouches_changed' using errcode = 'P0001';
        end if;
        select pub into v_lend from public.system_wallets where signer = 'lending_ng';
        if v_lend is null then
          raise exception 'no_lending_account' using errcode = 'P0001';
        end if;
        insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status, counterparty)
        values (p_user_id, 'ng', 'loan', 'lending', v_amount, 'NGN', 'stellar', 'action:' || v_a.id, 'pending', 'Partner lender')
        returning * into v_tx;
        insert into public.loans (user_id, step, principal, cost, repay_bps, minimum, every_days, collateral_asset_id, collateral_pct,
                                  next_due_at, action_id, disburse_tx)
        values (p_user_id, (v_a.params ->> 'step')::smallint, v_amount, (v_a.params ->> 'cost')::bigint,
                (v_a.params ->> 'repay_bps')::integer, (v_a.params ->> 'minimum')::bigint, (v_a.params ->> 'every_days')::integer,
                nullif(v_a.params ->> 'collateral_asset_id', '')::uuid, (v_a.params ->> 'collateral_pct')::integer,
                now() + make_interval(days => (v_a.params ->> 'every_days')::integer), v_a.id, v_tx.id)
        returning * into v_loan;
        update public.transactions set source = v_loan.id::text where id = v_tx.id;
        v_out := public.chain_enqueue_on('lending_ng', 'payment', 'loan:' || v_a.id, jsonb_build_object(
          'asset', 'NGNT', 'to', v_u.stellar_pub, 'amount', (v_amount * 100000)::text, 'transaction_id', v_tx.id));
        insert into public.loan_events (loan_id, user_id, kind, amount) values (v_loan.id, p_user_id, 'disbursed', v_amount);
        v_result := jsonb_build_object('loan_id', v_loan.id, 'cost', v_loan.cost, 'total', v_loan.total,
          'vouches', (select count(*) from public.vouches where loan_id = v_loan.id));

      when 'loan_repay' then
        v_id := public.ng_loan_repay(p_user_id, v_amount, 'action:' || v_a.id, null, 'repay_now');
        if v_id is null then
          raise exception 'no_loan_open' using errcode = 'P0001';
        end if;
        select * into v_tx from public.transactions where id = v_id;
        v_amount := -v_tx.amount;
        v_result := jsonb_build_object('loan_id', v_tx.source);

      when 'loan_extension' then
        update public.loans
           set next_due_at = next_due_at + make_interval(days => (v_a.params ->> 'days')::integer),
               extended_once = true, borrowing_paused = true, grace_until = null
         where id = (v_a.params ->> 'loan_id')::uuid and user_id = p_user_id
           and status in ('active', 'late', 'restructured') and not extended_once
        returning * into v_loan;
        if not found then
          raise exception 'not_available' using errcode = 'P0001';
        end if;
        insert into public.loan_events (loan_id, user_id, kind, note)
        values (v_loan.id, p_user_id, 'extended', 'next payment moved; new borrowing paused');
        v_result := jsonb_build_object('loan_id', v_loan.id, 'next_due_at', v_loan.next_due_at);

      when 'loan_restructure' then
        update public.loans
           set minimum = (v_a.params ->> 'minimum')::bigint, status = 'restructured', restructured_once = true,
               grace_until = null, next_due_at = greatest(next_due_at, now()) + make_interval(days => every_days)
         where id = (v_a.params ->> 'loan_id')::uuid and user_id = p_user_id
           and status in ('active', 'late') and not restructured_once
        returning * into v_loan;
        if not found then
          raise exception 'not_available' using errcode = 'P0001';
        end if;
        insert into public.loan_events (loan_id, user_id, kind, amount, note)
        values (v_loan.id, p_user_id, 'restructured', v_loan.minimum, 'smaller minimum, longer time');
        v_result := jsonb_build_object('loan_id', v_loan.id, 'minimum', v_loan.minimum, 'next_due_at', v_loan.next_due_at);

      when 'bank_send' then
        -- To a bank account: NGNT to the partner's anchor (anchor_ng), which pays the account
        -- (simulated). Shown as "Sent to bank (partner, simulated)".
        select pub into v_lend from public.system_wallets where signer = 'anchor_ng';
        if v_lend is null then
          raise exception 'no_anchor' using errcode = 'P0001';
        end if;
        if coalesce(v_a.params ->> 'account_number', '') !~ '^[0-9]{10}$' or coalesce(v_a.params ->> 'bank_code', '') = '' then
          raise exception 'invalid_account' using errcode = 'P0001';
        end if;
        insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status, counterparty)
        values (p_user_id, 'ng', 'pay', 'bank', -v_amount, 'NGN', 'stellar', 'action:' || v_a.id, 'pending',
                left((v_a.params ->> 'account_name') || ', ' || (v_a.params ->> 'bank_name'), 80))
        returning * into v_tx;
        v_out := public.chain_enqueue_on(v_signer, 'payment', 'bank_send:' || v_a.id, jsonb_build_object(
          'asset', 'NGNT', 'to', v_lend, 'amount', (v_amount * 100000)::text, 'transaction_id', v_tx.id));
        insert into public.bank_withdrawals (user_id, action_id, transaction_id, outbox_id, amount, bank_code, bank_name, account_number, account_name)
        values (p_user_id, v_a.id, v_tx.id, v_out, v_amount, v_a.params ->> 'bank_code', v_a.params ->> 'bank_name',
                v_a.params ->> 'account_number', v_a.params ->> 'account_name');
        v_result := jsonb_build_object('payee_name', v_a.params ->> 'payee_name', 'account_name', v_a.params ->> 'account_name',
                                       'bank_name', v_a.params ->> 'bank_name', 'account_last4', right(v_a.params ->> 'account_number', 4));

      -- Piece 9: share her record with a lender. Only a keyed hash of the code is stored; the
      -- code itself is shown once, on her screen.
      when 'record_share' then
        if coalesce(p_extra ->> 'code', '') !~ '^[A-HJKMNP-Z2-9]{8}$' then
          raise exception 'missing_code' using errcode = 'P0001';
        end if;
        if (select count(*) from public.record_shares
             where user_id = p_user_id and revoked_at is null and expires_at > now()) >= 5 then
          raise exception 'too_many_shares' using errcode = 'P0001';
        end if;
        insert into public.record_shares (user_id, code_hash, action_id, expires_at)
        values (p_user_id, private.credit_ref('share:' || (p_extra ->> 'code')), v_a.id, now() + interval '24 hours')
        returning id into v_id;
        v_result := jsonb_build_object('share_id', v_id, 'expires_at', now() + interval '24 hours');

      -- Piece 10: vouch for an ajo member's next loan (re-checked now; written to plus_credit).
      when 'vouch' then
        v_id := public.vouch_record(p_user_id, (v_a.params ->> 'borrower_user_id')::uuid, v_a.id);
        v_result := jsonb_build_object('vouch_id', v_id, 'borrower_name', v_a.params ->> 'borrower_name');

      -- Piece 11: savings. Her goal is a pot on the plus contract (she is sender and payout): the
      -- contract holds it, out of daily spending; only she can take it out, back to her wallet.
      when 'save' then
        select * into v_goal from public.savings_goals where user_id = p_user_id and status = 'active';
        if not found or v_goal.onchain_pot_id is null then
          raise exception 'no_savings_goal' using errcode = 'P0001';
        end if;
        insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status, counterparty)
        values (p_user_id, 'ng', 'saved', 'manual', -v_amount, 'NGN', 'stellar', 'action:' || v_a.id, 'pending', v_goal.name)
        returning * into v_tx;
        v_out := public.chain_enqueue_on(v_signer, 'contract', 'pot_fund:' || v_a.id, jsonb_build_object(
          'fn', 'pot_fund',
          'args', jsonb_build_array(jsonb_build_object('t', 'address', 'v', v_u.stellar_pub),
                                    jsonb_build_object('t', 'u32', 'v', v_goal.onchain_pot_id),
                                    jsonb_build_object('t', 'i128', 'v', (v_amount * 100000)::text)),
          'transaction_id', v_tx.id));
        v_result := jsonb_build_object('goal_name', v_goal.name);

      when 'savings_withdraw' then
        select * into v_goal from public.savings_goals where user_id = p_user_id and status = 'active';
        if not found or v_goal.onchain_pot_id is null then
          raise exception 'no_savings_goal' using errcode = 'P0001';
        end if;
        if public.ng_savings_balance(p_user_id) < v_amount then
          raise exception 'not_enough_saved' using errcode = 'P0001';
        end if;
        insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status, counterparty)
        values (p_user_id, 'ng', 'savings_out', 'savings', v_amount, 'NGN', 'stellar', 'action:' || v_a.id, 'pending', v_goal.name)
        returning * into v_tx;
        v_out := public.chain_enqueue_on(v_signer, 'contract', 'pot_send:' || v_a.id, jsonb_build_object(
          'fn', 'pot_send',
          'args', jsonb_build_array(jsonb_build_object('t', 'address', 'v', v_u.stellar_pub),
                                    jsonb_build_object('t', 'u32', 'v', v_goal.onchain_pot_id),
                                    jsonb_build_object('t', 'i128', 'v', (v_amount * 100000)::text)),
          'transaction_id', v_tx.id));
        v_result := jsonb_build_object('goal_name', v_goal.name);

      else
        raise exception 'unknown_action_kind' using errcode = 'P0001';
    end case;

    v_result := v_result || jsonb_build_object('ok', true, 'sending', v_tx.id is not null, 'amount', v_amount,
                                               'transaction_id', v_tx.id, 'outbox_id', v_out);
    update public.pending_actions set status = 'done', result = v_result where id = v_a.id
    returning * into v_a;
  exception when sqlstate 'P0001' then
    update public.pending_actions
       set status = 'failed', result = jsonb_build_object('ok', false, 'error', sqlerrm)
     where id = v_a.id
    returning * into v_a;
  end;
  return jsonb_build_object('action', to_jsonb(v_a), 'claimed', true);
end;
$$;
