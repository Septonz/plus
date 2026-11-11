-- Piece 10: the ajo vouches.
--
-- A member of an ajo in good standing (verified ID, 6+ weeks with Plus, every ajo payment on time
-- on Stellar, no late or defaulted loan, not banned) vouches for another member's next loan, with
-- her PIN. Each vouch is written to plus_credit (vouch / vouch_revoke on the partner's queue, as
-- 32-byte references only). When the borrower's loan opens, her waiting vouches attach to it
-- (on-chain too: loan_open takes them). Two or more vouches lower the collateral her offer needs
-- (market pack: lending.vouch). If a vouched loan defaults, each voucher loses vouching rights for
-- 6 months and her other waiting vouches are withdrawn. No money is ever taken from a voucher.
--
-- The numbers here mirror packages/markets (lending.vouch: minWeeks 6, banMonths 6, max 10).

alter table public.users add column if not exists vouch_banned_until timestamptz;

create table public.vouches (
  id uuid primary key default gen_random_uuid(),
  voucher_user_id uuid not null references public.users (id),
  borrower_user_id uuid not null references public.users (id),
  group_id uuid references public.groups (id),
  action_id uuid references public.pending_actions (id),
  -- active: waiting for her next loan; used: attached to loan_id; revoked: withdrawn before a loan;
  -- defaulted: the loan it backed defaulted (the voucher is banned from vouching for 6 months).
  status text not null default 'active' check (status in ('active', 'used', 'revoked', 'defaulted')),
  loan_id uuid references public.loans (id),
  credit_tx_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (voucher_user_id <> borrower_user_id)
);
create unique index vouches_one_active on public.vouches (voucher_user_id, borrower_user_id) where status = 'active';
create index vouches_borrower on public.vouches (borrower_user_id, status);
create index vouches_loan on public.vouches (loan_id) where loan_id is not null;
alter table public.vouches enable row level security;
-- No policies: read and written only through the service role (agent-tools) and the functions below.

-- ---------------------------------------------------------------------------
-- Her ajo payments on Stellar (the plus contract's "contributed" events, synced by sync-events):
-- how many, and how many came more than 1.5 rounds after her previous one into the same ajo.
-- Ledgers close about every 5 seconds.
-- ---------------------------------------------------------------------------
create or replace function private.ajo_record(p_pub text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with p as (
    select (e.topics ->> 1)::integer as grp, e.ledger,
           lag(e.ledger) over (partition by e.topics ->> 1 order by e.ledger) as prev
      from public.chain_events e
     where e.type = 'contributed' and e.topics ->> 2 = p_pub
  )
  select jsonb_build_object(
    'payments', count(*),
    'late', count(*) filter (where p.prev is not null
                             and (p.ledger - p.prev) * 5 > 1.5 * coalesce(g.period_secs, 86400)))
    from p
    left join lateral (select period_secs from public.groups where onchain_id = p.grp order by created_at limit 1) g on true;
$$;
revoke execute on function private.ajo_record(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Can this person vouch for that one? { ok, reason, group_id, group_name, ... }.
-- ---------------------------------------------------------------------------
create or replace function public.vouch_check(p_voucher uuid, p_borrower uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.users;
  b public.users;
  v_group record;
  v_ajo jsonb;
begin
  select * into v from public.users where id = p_voucher and archived_at is null;
  select * into b from public.users where id = p_borrower and archived_at is null;
  if v.id is null or b.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v.id = b.id then
    return jsonb_build_object('ok', false, 'reason', 'self');
  end if;
  select g.id, g.name into v_group
    from public.groups g
    join public.group_members a on a.group_id = g.id and a.user_id = v.id
    join public.group_members m on m.group_id = g.id and m.user_id = b.id
   order by g.created_at desc limit 1;
  if v_group.id is null or v.market_id <> b.market_id then
    return jsonb_build_object('ok', false, 'reason', 'not_same_ajo');
  end if;
  if v.vouch_banned_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'banned', 'until', v.vouch_banned_until);
  end if;
  if v.kyc_tier < 2 then
    return jsonb_build_object('ok', false, 'reason', 'identity');
  end if;
  if v.member_since is null or v.member_since > now() - interval '6 weeks' then
    return jsonb_build_object('ok', false, 'reason', 'too_new',
      'weeks', greatest(0, floor(extract(epoch from now() - coalesce(v.member_since, now())) / 604800))::integer);
  end if;
  if v.borrowing_frozen_until > now()
     or exists (select 1 from public.loans where user_id = v.id and status in ('late', 'default') and not closed_by_reset) then
    return jsonb_build_object('ok', false, 'reason', 'standing');
  end if;
  v_ajo := private.ajo_record(v.stellar_pub);
  if v.stellar_pub is null or (v_ajo ->> 'payments')::integer = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_ajo_payments');
  end if;
  if (v_ajo ->> 'late')::integer > 0 then
    return jsonb_build_object('ok', false, 'reason', 'ajo_late', 'late', (v_ajo ->> 'late')::integer);
  end if;
  if exists (select 1 from public.vouches where voucher_user_id = v.id and borrower_user_id = b.id and status = 'active') then
    return jsonb_build_object('ok', false, 'reason', 'already');
  end if;
  if (select count(*) from public.vouches where borrower_user_id = b.id and status = 'active') >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  return jsonb_build_object('ok', true, 'group_id', v_group.id, 'group_name', v_group.name,
    'ajo_payments', (v_ajo ->> 'payments')::integer, 'borrower_name', b.name);
end;
$$;
revoke execute on function public.vouch_check(uuid, uuid) from public, anon, authenticated;
grant execute on function public.vouch_check(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Record a vouch (re-checked here) and write it to plus_credit. Raises the reason (P0001) when
-- she can't. Used by ng_execute_pending_action (her PIN) and by the demo reset.
-- ---------------------------------------------------------------------------
create or replace function public.vouch_record(p_voucher uuid, p_borrower uuid, p_action_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check jsonb;
  v_id uuid;
begin
  v_check := public.vouch_check(p_voucher, p_borrower);
  if not (v_check ->> 'ok')::boolean then
    raise exception '%', 'vouch_' || (v_check ->> 'reason') using errcode = 'P0001';
  end if;
  insert into public.vouches (voucher_user_id, borrower_user_id, group_id, action_id)
  values (p_voucher, p_borrower, (v_check ->> 'group_id')::uuid, p_action_id)
  returning id into v_id;
  perform private.credit_enqueue('vouch:' || v_id, 'vouch', jsonb_build_array(
    jsonb_build_object('t', 'bytes32', 'v', private.credit_ref('user:' || p_borrower::text)),
    jsonb_build_object('t', 'bytes32', 'v', private.credit_ref('user:' || p_voucher::text))),
    jsonb_build_object('vouch_id', v_id));
  return v_id;
end;
$$;
revoke execute on function public.vouch_record(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.vouch_record(uuid, uuid, uuid) to service_role;

-- Withdraw a waiting vouch (hers only, before the loan opens). False when it isn't waiting.
create or replace function public.vouch_withdraw(p_voucher uuid, p_vouch_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.vouches;
begin
  update public.vouches set status = 'revoked', updated_at = now()
   where id = p_vouch_id and voucher_user_id = p_voucher and status = 'active'
  returning * into v;
  if not found then
    return false;
  end if;
  perform private.credit_enqueue('vouch_revoke:' || v.id, 'vouch_revoke', jsonb_build_array(
    jsonb_build_object('t', 'bytes32', 'v', private.credit_ref('user:' || v.borrower_user_id::text)),
    jsonb_build_object('t', 'bytes32', 'v', private.credit_ref('user:' || v.voucher_user_id::text))),
    jsonb_build_object('vouch_id', v.id));
  return true;
end;
$$;
revoke execute on function public.vouch_withdraw(uuid, uuid) from public, anon, authenticated;
grant execute on function public.vouch_withdraw(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Her loan opens: her waiting vouches attach to it (plus_credit's loan_open takes them the same
-- way). Runs before loans_credit (alphabetical), which only enqueues loan_open after them.
-- ---------------------------------------------------------------------------
create or replace function private.vouches_on_loan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.vouches;
begin
  if tg_op = 'INSERT' then
    update public.vouches set status = 'used', loan_id = new.id, updated_at = now()
     where borrower_user_id = new.user_id and status = 'active';
  elsif new.status = 'default' and old.status is distinct from 'default' and not new.closed_by_reset then
    -- No money is taken: each voucher loses vouching rights for 6 months, and her other waiting
    -- vouches are withdrawn (on-chain too).
    update public.vouches set status = 'defaulted', updated_at = now() where loan_id = new.id and status = 'used';
    update public.users set vouch_banned_until = greatest(coalesce(vouch_banned_until, now()), now() + interval '6 months')
     where id in (select voucher_user_id from public.vouches where loan_id = new.id);
    for v in select w.* from public.vouches w
              where w.status = 'active'
                and w.voucher_user_id in (select voucher_user_id from public.vouches where loan_id = new.id) loop
      perform public.vouch_withdraw(v.voucher_user_id, v.id);
    end loop;
  end if;
  return new;
end;
$$;
revoke execute on function private.vouches_on_loan() from public, anon, authenticated;
create trigger loans_a_vouches after insert or update of status on public.loans
  for each row execute function private.vouches_on_loan();

-- Done on Stellar: the vouch's tick links to that transaction.
create or replace function private.vouch_on_done()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.vouches set credit_tx_hash = new.tx_hash where id = (new.args ->> 'vouch_id')::uuid;
  return new;
end;
$$;
revoke execute on function private.vouch_on_done() from public, anon, authenticated;
create trigger chain_outbox_vouch_done after update of status on public.chain_outbox
  for each row when (new.status = 'done' and old.status is distinct from 'done' and new.args ? 'vouch_id')
  execute function private.vouch_on_done();

-- ---------------------------------------------------------------------------
-- The action executor, with 'vouch' (no money, no wallet signature: plus_credit is written by the
-- partner) and the loan's vouch re-check. Everything else unchanged from piece 9.
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
    if v_a.kind in ('pay', 'pay_code', 'group_contribution', 'cash_out', 'loan_repay', 'bank_send') and public.ng_available(p_user_id) < v_amount then
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
