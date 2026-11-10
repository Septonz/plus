-- Nigeria: outgoing money is stored negative in transactions, as for India (pay, group_contribution,
-- cash_out, repay). ng_available subtracts outgoing amounts still on their way.

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
                      and kind in ('pay', 'group_contribution', 'cash_out', 'repay')), 0);
$$;

-- ---------------------------------------------------------------------------
-- ng_execute_pending_action: claim (one atomic update), check, write a pending transaction and
-- queue the Stellar work in the same database transaction. Returns { action, claimed }: claimed is
-- true only for the call that ran it; retries get the stored action back and change nothing.
-- p_extra carries values computed by the Edge Function at confirm time:
--   cash_out:        { code_hash }
--   confirm_cash_in: { repay } (kobo of an open advance to repay, 10% of the cash-in)
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
  v_tx public.transactions;
  v_repay_tx public.transactions;
  v_amount bigint;
  v_signer text;
  v_out bigint;
  v_out2 bigint;
  v_co uuid;
  v_repay bigint;
  v_result jsonb;
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
    if v_u.market_id <> 'ng' or v_u.stellar_pub is null or v_signer is null then
      raise exception 'no_wallet' using errcode = 'P0001';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'invalid_amount' using errcode = 'P0001';
    end if;

    -- Money leaving her wallet: she must have it now (cache minus what is already on its way).
    if v_a.kind in ('pay', 'group_contribution', 'cash_out') and public.ng_available(p_user_id) < v_amount then
      raise exception 'insufficient_funds' using errcode = 'P0001';
    end if;

    case v_a.kind
      when 'pay' then
        insert into public.transactions (user_id, market_id, kind, amount, currency, rail, ref, status)
        values (p_user_id, 'ng', 'pay', -v_amount, 'NGN', 'stellar', 'action:' || v_a.id, 'pending')
        returning * into v_tx;
        v_out := public.chain_enqueue_on(v_signer, 'payment', 'pay:' || v_a.id, jsonb_build_object(
          'asset', 'NGNT', 'to', v_a.params ->> 'to', 'amount', (v_amount * 100000)::text, 'transaction_id', v_tx.id));
        v_result := jsonb_build_object('payee_name', v_a.params ->> 'payee_name');

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
        insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status)
        values (p_user_id, 'ng', 'incoming', 'cash', v_amount, 'NGN', 'stellar', 'cash_in:' || (v_a.params ->> 'cash_event_id'), 'pending')
        returning * into v_tx;
        -- The agent's float pays her wallet.
        v_out := public.chain_enqueue_on(public.signer_of(v_h.secret_name), 'payment', 'cash_in:' || (v_a.params ->> 'cash_event_id'),
          jsonb_build_object('asset', 'NGNT', 'to', v_u.stellar_pub, 'amount', (v_amount * 100000)::text, 'transaction_id', v_tx.id));
        update public.cash_events set rail_ref = v_tx.id::text where id = (v_a.params ->> 'cash_event_id')::uuid;
        -- An open advance is repaid with 10% of it, right after the cash lands (same queued sequence).
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
        v_result := jsonb_build_object('helper_name', v_a.params ->> 'helper_name', 'repay', coalesce(v_repay, 0),
                                       'repay_transaction_id', v_repay_tx.id);

      else
        raise exception 'unknown_action_kind' using errcode = 'P0001';
    end case;

    v_result := v_result || jsonb_build_object('ok', true, 'sending', true, 'amount', v_amount,
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
