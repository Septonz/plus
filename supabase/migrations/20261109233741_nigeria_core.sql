-- Nigeria core: the user's Stellar wallet is her account. Money moves on Stellar through the
-- chain outbox; the database keeps the two-step actions, a balance cache and cash-out codes.

-- Demo users (dev project only).
alter table public.users add column is_demo boolean not null default false;

-- Signing account name for a key held in Supabase secrets: STELLAR_SECRET_FUNMI -> funmi.
create or replace function public.signer_of(p_secret_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_secret_name ~ '^STELLAR_SECRET_[A-Z][A-Z0-9_]{0,31}$'
              then lower(substr(p_secret_name, 16)) end;
$$;

-- ---------------------------------------------------------------------------
-- wallet_balances: what voice and the app read. Refreshed from Horizon after every confirmed
-- transaction (chain-worker) and every minute (scheduler). Amounts in minor units (kobo, cents).
-- ---------------------------------------------------------------------------
create table public.wallet_balances (
  user_id uuid not null references public.users (id) on delete cascade,
  asset text not null check (asset in ('NGNT', 'USDC', 'XLM')),
  amount bigint not null check (amount >= 0),
  horizon_ms integer,                 -- how long the Horizon read took
  updated_at timestamptz not null default now(),
  primary key (user_id, asset)
);
alter table public.wallet_balances enable row level security;
create policy wallet_balances_read on public.wallet_balances for select to authenticated
  using ((select private.is_staff()) or user_id = (select private.current_plus_user_id()));
alter publication supabase_realtime add table public.wallet_balances;

-- ---------------------------------------------------------------------------
-- cash_out_codes: a cash-out is a claimable balance from her wallet, claimable by registered
-- agents (or back by her after 7 days), plus a 6-digit code she shows the agent. Only an HMAC
-- of the code is stored, and app users cannot read even that column.
-- ---------------------------------------------------------------------------
create table public.cash_out_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  action_id uuid not null unique references public.pending_actions (id),
  amount bigint not null check (amount > 0),
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  attempts integer not null default 0,
  status text not null default 'issued' check (status in ('issued', 'redeemed', 'returned')),
  create_outbox_id bigint references public.chain_outbox (id),
  claim_outbox_id bigint references public.chain_outbox (id),
  redeemed_by uuid references public.helpers (id),
  redeemed_at timestamptz,
  expires_at timestamptz not null,    -- after this the agent can no longer redeem; she can reclaim
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cash_out_codes_user_idx on public.cash_out_codes (user_id, created_at desc);
create trigger cash_out_codes_updated_at before update on public.cash_out_codes
  for each row execute function public.set_updated_at();
alter table public.cash_out_codes enable row level security;
revoke all on public.cash_out_codes from anon, authenticated;
grant select (id, user_id, action_id, amount, status, expires_at, redeemed_at, created_at) on public.cash_out_codes to authenticated;
create policy cash_out_codes_read on public.cash_out_codes for select to authenticated
  using ((select private.is_staff()) or user_id = (select private.current_plus_user_id()));
alter publication supabase_realtime add table public.cash_out_codes;

-- ---------------------------------------------------------------------------
-- ng_available: NGNT she can spend now = cached balance minus outgoing money still on its way.
-- ---------------------------------------------------------------------------
create or replace function public.ng_available(p_user_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select amount from public.wallet_balances where user_id = p_user_id and asset = 'NGNT'), 0)
       - coalesce((select sum(amount) from public.transactions
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
        values (p_user_id, 'ng', 'pay', v_amount, 'NGN', 'stellar', 'action:' || v_a.id, 'pending')
        returning * into v_tx;
        v_out := public.chain_enqueue_on(v_signer, 'payment', 'pay:' || v_a.id, jsonb_build_object(
          'asset', 'NGNT', 'to', v_a.params ->> 'to', 'amount', (v_amount * 100000)::text, 'transaction_id', v_tx.id));
        v_result := jsonb_build_object('payee_name', v_a.params ->> 'payee_name');

      when 'group_contribution' then
        insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status)
        values (p_user_id, 'ng', 'group_contribution', v_a.params ->> 'group_id', v_amount, 'NGN', 'stellar', 'action:' || v_a.id, 'pending')
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
        values (p_user_id, 'ng', 'cash_out', v_amount, 'NGN', 'stellar', 'action:' || v_a.id, 'pending')
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
          values (p_user_id, 'ng', 'repay', v_repay, 'NGN', 'stellar', 'repay:' || (v_a.params ->> 'cash_event_id'), 'pending')
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

-- ---------------------------------------------------------------------------
-- agent_record_cash_in: a registered agent (Mama Bisi) records cash a customer handed over.
-- Checks her daily limit and her float (Horizon balance passed in, minus cash-ins still awaiting
-- or on their way) under a lock on the agent, then creates the pending action for the customer.
-- ---------------------------------------------------------------------------
create or replace function public.agent_record_cash_in(
  p_helper_id uuid, p_user_id uuid, p_amount bigint, p_idempotency_key text, p_readback text, p_float bigint)
returns public.cash_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h public.helpers;
  v_u public.users;
  v_ce public.cash_events;
  v_used bigint;
  v_committed bigint;
  v_day_start timestamptz;
  v_pa_id uuid := gen_random_uuid();
  v_ce_id uuid := gen_random_uuid();
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if coalesce(p_idempotency_key, '') = '' then
    raise exception 'missing_idempotency_key' using errcode = '22023';
  end if;

  select * into v_h from public.helpers where id = p_helper_id for update;
  if not found or not v_h.active or v_h.role <> 'agent' then
    raise exception 'helper_inactive' using errcode = 'P0001';
  end if;

  select * into v_ce from public.cash_events where helper_id = p_helper_id and idempotency_key = p_idempotency_key;
  if found then
    return v_ce;
  end if;

  select * into v_u from public.users where id = p_user_id;
  if not found or v_u.market_id <> v_h.market_id or v_u.stellar_pub is null then
    raise exception 'not_a_customer' using errcode = 'P0001';
  end if;

  v_day_start := date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos';
  select coalesce(sum(amount), 0) into v_used from public.cash_events
   where helper_id = p_helper_id and created_at >= v_day_start and status in ('awaiting_user', 'confirmed');
  if v_used + p_amount > v_h.daily_limit then
    raise exception 'daily_limit_exceeded' using errcode = 'P0001';
  end if;

  -- Float: what she holds on Stellar, minus cash-ins awaiting a Yes or confirmed but not yet sent.
  select coalesce(sum(c.amount), 0) into v_committed from public.cash_events c
    left join public.transactions t on t.id::text = c.rail_ref
   where c.helper_id = p_helper_id
     and (c.status = 'awaiting_user' or (c.status = 'confirmed' and t.status = 'pending'));
  if p_float is null or p_float - v_committed < p_amount then
    raise exception 'float_too_low' using errcode = 'P0001';
  end if;

  insert into public.pending_actions (id, user_id, kind, params, readback, expires_at, created_by)
  values (v_pa_id, p_user_id, 'confirm_cash_in',
          jsonb_build_object('cash_event_id', v_ce_id, 'amount', p_amount, 'helper_id', p_helper_id, 'helper_name', v_h.name),
          p_readback, now() + interval '24 hours', 'helper');
  insert into public.cash_events (id, helper_id, user_id, direction, amount, status, pending_action_id, idempotency_key)
  values (v_ce_id, p_helper_id, p_user_id, 'in', p_amount, 'awaiting_user', v_pa_id, p_idempotency_key)
  returning * into v_ce;
  return v_ce;
end;
$$;

-- ---------------------------------------------------------------------------
-- Redeeming a cash-out code: the Edge Function checks the HMAC; this records attempts and the
-- redemption atomically and queues the agent's claim of the claimable balance.
-- ---------------------------------------------------------------------------
create or replace function public.cash_out_redeem(p_cash_out_id uuid, p_helper_id uuid, p_code_ok boolean, p_balance_id text)
returns public.cash_out_codes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.cash_out_codes;
  v_h public.helpers;
  v_claim bigint;
begin
  select * into v_c from public.cash_out_codes where id = p_cash_out_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_c.status = 'redeemed' and v_c.redeemed_by = p_helper_id then
    return v_c;   -- retried call
  end if;
  if v_c.status <> 'issued' then
    raise exception 'not_redeemable' using errcode = 'P0001';
  end if;
  if v_c.expires_at <= now() then
    raise exception 'code_expired' using errcode = 'P0001';
  end if;
  if v_c.attempts >= 5 then
    raise exception 'too_many_attempts' using errcode = 'P0001';
  end if;
  if not p_code_ok then
    update public.cash_out_codes set attempts = attempts + 1 where id = v_c.id returning * into v_c;
    return v_c;   -- caller reports the wrong code; status stays issued
  end if;
  if coalesce(p_balance_id, '') !~ '^[0-9a-f]{72}$' then
    raise exception 'not_on_chain_yet' using errcode = 'P0001';
  end if;
  select * into v_h from public.helpers where id = p_helper_id;
  if public.signer_of(v_h.secret_name) is null then
    raise exception 'agent_has_no_wallet' using errcode = 'P0001';
  end if;
  v_claim := public.chain_enqueue_on(public.signer_of(v_h.secret_name), 'claimable_claim', 'cash_out_claim:' || v_c.id,
    jsonb_build_object('balance_id', p_balance_id));
  update public.cash_out_codes
     set status = 'redeemed', redeemed_by = p_helper_id, redeemed_at = now(), claim_outbox_id = v_claim
   where id = v_c.id
  returning * into v_c;
  return v_c;
end;
$$;

revoke execute on function public.signer_of(text) from public, anon, authenticated;
revoke execute on function public.ng_available(uuid) from public, anon, authenticated;
revoke execute on function public.ng_execute_pending_action(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.agent_record_cash_in(uuid, uuid, bigint, text, text, bigint) from public, anon, authenticated;
revoke execute on function public.cash_out_redeem(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.signer_of(text) to service_role;
grant execute on function public.ng_available(uuid) to service_role;
grant execute on function public.ng_execute_pending_action(uuid, uuid, jsonb) to service_role;
grant execute on function public.agent_record_cash_in(uuid, uuid, bigint, text, text, bigint) to service_role;
grant execute on function public.cash_out_redeem(uuid, uuid, boolean, text) to service_role;
