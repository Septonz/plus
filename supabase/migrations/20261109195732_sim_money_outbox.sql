-- sim_* money functions v2: each money movement also queues its on-chain record in
-- chain_outbox in the same transaction (attest received / saved / paid, or group_record).
-- Users without an on-chain ref (ref_hash) get no outbox rows. Amounts on-chain are i128 with
-- 7 decimals: paise * 100000. payment_ref = sha256(transaction ref), never personal data.

create or replace function public.payment_ref_hex(p_ref text)
returns text
language sql
immutable
set search_path = ''
as $$ select encode(sha256(convert_to(p_ref, 'UTF8')), 'hex') $$;

create or replace function public.chain_enqueue(p_kind text, p_ref text, p_args jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.chain_outbox (kind, ref, args) values (p_kind, p_ref, p_args)
  on conflict (ref) do nothing;
$$;

create or replace function public.sim_credit(p_user_id uuid, p_amount bigint, p_source text, p_ref text)
returns public.transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rail text := case when p_source = 'cash' then 'helper' else 'upi_sim' end;
  v_acct public.sim_bank_accounts;
  v_user public.users;
  v_tx public.transactions;
  v_save_tx public.transactions;
  v_save bigint;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if p_ref is null or p_ref = '' then
    raise exception 'missing_ref' using errcode = '22023';
  end if;

  select * into v_acct from public.sim_bank_accounts where user_id = p_user_id for update;
  if not found then
    raise exception 'no_sim_account' using errcode = 'P0002';
  end if;

  select * into v_tx from public.transactions where rail = v_rail and ref = p_ref;
  if found then
    if v_tx.user_id <> p_user_id then
      raise exception 'ref_conflict' using errcode = '23505';
    end if;
    return v_tx;   -- already applied: change nothing
  end if;

  select * into v_user from public.users where id = p_user_id;
  v_save := p_amount * v_user.auto_save_bps / 10000;   -- integer division, rounds down

  insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status)
  values (p_user_id, v_user.market_id, 'incoming', p_source, p_amount, 'INR', v_rail, p_ref, 'completed')
  returning * into v_tx;

  if v_save > 0 then
    insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status)
    values (p_user_id, v_user.market_id, 'saved', 'auto_save', -v_save, 'INR', 'upi_sim', p_ref || ':save', 'completed')
    returning * into v_save_tx;
  end if;

  update public.sim_bank_accounts
     set balance_paise = balance_paise + p_amount - v_save,
         savings_paise = savings_paise + v_save
   where user_id = p_user_id;

  if v_user.ref_hash is not null then
    perform public.chain_enqueue('attest', 'attest:' || v_rail || ':' || p_ref, jsonb_build_object(
      'user_ref', v_user.ref_hash, 'kind', 'received', 'amount', (p_amount * 100000)::text,
      'payment_ref', public.payment_ref_hex(p_ref), 'transaction_id', v_tx.id));
    if v_save > 0 then
      perform public.chain_enqueue('attest', 'attest:upi_sim:' || p_ref || ':save', jsonb_build_object(
        'user_ref', v_user.ref_hash, 'kind', 'saved', 'amount', (v_save * 100000)::text,
        'payment_ref', public.payment_ref_hex(p_ref || ':save'), 'transaction_id', v_save_tx.id));
    end if;
  end if;

  return v_tx;
end;
$$;

-- sim_debit gains p_group_id (required for group_contribution) to queue the group_record.
drop function public.sim_debit(uuid, bigint, text, text);

create or replace function public.sim_debit(
  p_user_id uuid, p_amount bigint, p_kind text, p_ref text, p_group_id uuid default null)
returns public.transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rail text := case when p_kind = 'cash_out' then 'helper' else 'upi_sim' end;
  v_acct public.sim_bank_accounts;
  v_user public.users;
  v_group public.groups;
  v_member_ref text;
  v_tx public.transactions;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if p_ref is null or p_ref = '' then
    raise exception 'missing_ref' using errcode = '22023';
  end if;
  if p_kind is null or p_kind in ('incoming', 'saved') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  if p_kind = 'group_contribution' and p_group_id is null then
    raise exception 'missing_group' using errcode = '22023';
  end if;

  select * into v_acct from public.sim_bank_accounts where user_id = p_user_id for update;
  if not found then
    raise exception 'no_sim_account' using errcode = 'P0002';
  end if;

  select * into v_tx from public.transactions where rail = v_rail and ref = p_ref;
  if found then
    if v_tx.user_id <> p_user_id then
      raise exception 'ref_conflict' using errcode = '23505';
    end if;
    return v_tx;
  end if;

  if v_acct.balance_paise < p_amount then
    raise exception 'insufficient_funds'
      using errcode = 'P0001', detail = format('balance %s, needed %s', v_acct.balance_paise, p_amount);
  end if;

  select * into v_user from public.users where id = p_user_id;

  if p_kind = 'group_contribution' then
    select * into v_group from public.groups where id = p_group_id;
    select m.member_ref into v_member_ref from public.group_members m
     where m.group_id = p_group_id and m.user_id = p_user_id;
    if v_group.id is null or v_member_ref is null then
      raise exception 'not_member' using errcode = 'P0001';
    end if;
  end if;

  insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status)
  values (p_user_id, v_user.market_id, p_kind, case when p_group_id is not null then p_group_id::text end,
          -p_amount, 'INR', v_rail, p_ref, 'completed')
  returning * into v_tx;

  update public.sim_bank_accounts set balance_paise = balance_paise - p_amount where user_id = p_user_id;

  if p_kind = 'group_contribution' and v_group.mode = 'record' and v_group.onchain_id is not null then
    perform public.chain_enqueue('group_record', 'group_record:' || v_rail || ':' || p_ref, jsonb_build_object(
      'group_id', v_group.onchain_id, 'member_ref', v_member_ref, 'amount', (p_amount * 100000)::text,
      'payment_ref', public.payment_ref_hex(p_ref), 'transaction_id', v_tx.id));
  elsif v_user.ref_hash is not null then
    perform public.chain_enqueue('attest', 'attest:' || v_rail || ':' || p_ref, jsonb_build_object(
      'user_ref', v_user.ref_hash, 'kind', 'paid', 'amount', (p_amount * 100000)::text,
      'payment_ref', public.payment_ref_hex(p_ref), 'transaction_id', v_tx.id));
  end if;

  return v_tx;
end;
$$;

create or replace function public.sim_move_to_savings(p_user_id uuid, p_amount bigint, p_ref text)
returns public.transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_acct public.sim_bank_accounts;
  v_user public.users;
  v_tx public.transactions;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if p_ref is null or p_ref = '' then
    raise exception 'missing_ref' using errcode = '22023';
  end if;

  select * into v_acct from public.sim_bank_accounts where user_id = p_user_id for update;
  if not found then
    raise exception 'no_sim_account' using errcode = 'P0002';
  end if;

  select * into v_tx from public.transactions where rail = 'upi_sim' and ref = p_ref;
  if found then
    if v_tx.user_id <> p_user_id then
      raise exception 'ref_conflict' using errcode = '23505';
    end if;
    return v_tx;
  end if;

  if v_acct.balance_paise < p_amount then
    raise exception 'insufficient_funds'
      using errcode = 'P0001', detail = format('balance %s, needed %s', v_acct.balance_paise, p_amount);
  end if;

  select * into v_user from public.users where id = p_user_id;

  insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status)
  values (p_user_id, v_user.market_id, 'saved', 'manual', -p_amount, 'INR', 'upi_sim', p_ref, 'completed')
  returning * into v_tx;

  update public.sim_bank_accounts
     set balance_paise = balance_paise - p_amount,
         savings_paise = savings_paise + p_amount
   where user_id = p_user_id;

  if v_user.ref_hash is not null then
    perform public.chain_enqueue('attest', 'attest:upi_sim:' || p_ref, jsonb_build_object(
      'user_ref', v_user.ref_hash, 'kind', 'saved', 'amount', (p_amount * 100000)::text,
      'payment_ref', public.payment_ref_hex(p_ref), 'transaction_id', v_tx.id));
  end if;

  return v_tx;
end;
$$;

revoke execute on function public.chain_enqueue(text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.sim_credit(uuid, bigint, text, text) from public, anon, authenticated;
revoke execute on function public.sim_debit(uuid, bigint, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.sim_move_to_savings(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.sim_credit(uuid, bigint, text, text) to service_role;
grant execute on function public.sim_debit(uuid, bigint, text, text, uuid) to service_role;
grant execute on function public.sim_move_to_savings(uuid, bigint, text) to service_role;
