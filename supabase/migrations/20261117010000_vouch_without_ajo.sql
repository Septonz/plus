-- Piece 13: vouches no longer depend on an ajo (community savings is retired from the product).
--
-- The new rule: any Plus user with a verified ID (kyc_tier >= 2), 6+ weeks on Plus and no missed
-- loan payments (no late or defaulted loan, borrowing not frozen, not banned) can vouch for someone
-- they have paid, or been paid by, at least 3 times on Stellar. Unchanged: two vouches lower a first
-- loan's collateral to 100%, at most 10 waiting vouches per borrower, and a 6-month vouching ban when
-- a vouched loan defaults (vouch_on_default, piece 10).
--
-- A payment between two Plus users leaves a transaction row on each side with the same Stellar
-- transaction hash (pay on one side, incoming on the other), so "paid or been paid by" counts the
-- completed hashes they share. private.ajo_record and vouches.group_id stay for history (old vouches
-- keep their group); new vouches leave group_id empty.

create index if not exists transactions_chain_tx_hash on public.transactions (chain_tx_hash) where chain_tx_hash is not null;

-- How many completed payments went between these two people (either way), on Stellar.
create or replace function private.trades_between(p_a uuid, p_b uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(distinct a.chain_tx_hash)::integer
    from public.transactions a
    join public.transactions b on b.chain_tx_hash = a.chain_tx_hash and b.user_id = p_b
   where a.user_id = p_a
     and a.chain_tx_hash is not null
     and a.kind in ('pay', 'incoming') and b.kind in ('pay', 'incoming')
     and a.status = 'completed' and b.status = 'completed';
$$;
revoke execute on function private.trades_between(uuid, uuid) from public, anon, authenticated;

-- Can this person vouch for that one? { ok, reason, trades, borrower_name }.
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
  v_trades integer;
begin
  select * into v from public.users where id = p_voucher and archived_at is null;
  select * into b from public.users where id = p_borrower and archived_at is null;
  if v.id is null or b.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v.id = b.id then
    return jsonb_build_object('ok', false, 'reason', 'self');
  end if;
  if v.market_id <> b.market_id then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
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
  v_trades := private.trades_between(v.id, b.id);
  if v_trades < 3 then
    return jsonb_build_object('ok', false, 'reason', 'few_trades', 'trades', v_trades);
  end if;
  if exists (select 1 from public.vouches where voucher_user_id = v.id and borrower_user_id = b.id and status = 'active') then
    return jsonb_build_object('ok', false, 'reason', 'already');
  end if;
  if (select count(*) from public.vouches where borrower_user_id = b.id and status = 'active') >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  return jsonb_build_object('ok', true, 'trades', v_trades, 'borrower_name', b.name);
end;
$$;
revoke execute on function public.vouch_check(uuid, uuid) from public, anon, authenticated;
grant execute on function public.vouch_check(uuid, uuid) to service_role;

-- The Plus users she has paid or been paid by on Stellar (newest first), with how many times: the
-- people she might vouch for.
create or replace function public.vouch_peers(p_user_id uuid)
returns table (user_id uuid, name text, trades integer)
language sql
stable
security definer
set search_path = ''
as $$
  select b.user_id, u.name, count(distinct a.chain_tx_hash)::integer
    from public.transactions a
    join public.transactions b on b.chain_tx_hash = a.chain_tx_hash and b.user_id <> a.user_id
    join public.users u on u.id = b.user_id and u.archived_at is null
   where a.user_id = p_user_id
     and a.chain_tx_hash is not null
     and a.kind in ('pay', 'incoming') and b.kind in ('pay', 'incoming')
     and a.status = 'completed' and b.status = 'completed'
   group by b.user_id, u.name
   order by max(a.created_at) desc
   limit 50;
$$;
revoke execute on function public.vouch_peers(uuid) from public, anon, authenticated;
grant execute on function public.vouch_peers(uuid) to service_role;

-- Record a vouch (re-checked here) and write it to plus_credit; new vouches carry no group.
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
  insert into public.vouches (voucher_user_id, borrower_user_id, action_id)
  values (p_voucher, p_borrower, p_action_id)
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
