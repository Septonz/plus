-- Atomic, idempotent money movement for simulated bank accounts (India).
-- Every balance change goes through one of these functions: each locks the account row,
-- returns the existing transactions row if the ref was already applied (changing nothing),
-- then updates sim_bank_accounts and inserts the transactions row in the same transaction.
-- transactions.amount is the change to the spendable balance: credits positive, debits and saves negative.
-- Service role only.

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
    values (p_user_id, v_user.market_id, 'saved', 'auto_save', -v_save, 'INR', 'upi_sim', p_ref || ':save', 'completed');
  end if;

  update public.sim_bank_accounts
     set balance_paise = balance_paise + p_amount - v_save,
         savings_paise = savings_paise + v_save
   where user_id = p_user_id;

  return v_tx;
end;
$$;

create or replace function public.sim_debit(p_user_id uuid, p_amount bigint, p_kind text, p_ref text)
returns public.transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rail text := case when p_kind = 'cash_out' then 'helper' else 'upi_sim' end;
  v_acct public.sim_bank_accounts;
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

  insert into public.transactions (user_id, market_id, kind, amount, currency, rail, ref, status)
  select p_user_id, u.market_id, p_kind, -p_amount, 'INR', v_rail, p_ref, 'completed'
    from public.users u where u.id = p_user_id
  returning * into v_tx;

  update public.sim_bank_accounts set balance_paise = balance_paise - p_amount where user_id = p_user_id;

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

  insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status)
  select p_user_id, u.market_id, 'saved', 'manual', -p_amount, 'INR', 'upi_sim', p_ref, 'completed'
    from public.users u where u.id = p_user_id
  returning * into v_tx;

  update public.sim_bank_accounts
     set balance_paise = balance_paise - p_amount,
         savings_paise = savings_paise + p_amount
   where user_id = p_user_id;

  return v_tx;
end;
$$;

revoke execute on function public.sim_credit(uuid, bigint, text, text) from public, anon, authenticated;
revoke execute on function public.sim_debit(uuid, bigint, text, text) from public, anon, authenticated;
revoke execute on function public.sim_move_to_savings(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.sim_credit(uuid, bigint, text, text) to service_role;
grant execute on function public.sim_debit(uuid, bigint, text, text) to service_role;
grant execute on function public.sim_move_to_savings(uuid, bigint, text) to service_role;
