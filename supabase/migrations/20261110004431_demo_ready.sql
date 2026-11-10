-- Demo readiness: rehearsal resets that only add rows, a live Stellar feed for the staff /demo view,
-- and an optional warm-up cron.

-- 1. Seettu round marker (India: contributions are recorded, so "paid this round" is read from
--    transactions). A reset starts a new round by moving the marker; no transaction is deleted.
alter table public.groups add column if not exists round_started_at timestamptz;
comment on column public.groups.round_started_at is
  'Start of the current round when it was started by hand (pnpm demo:reset). Contributions before it belong to an earlier round.';

-- 2. Set a simulated bank account (India) to a fixed state for a rehearsal. Adds one adjustment
--    transaction per changed balance (kind adjustment, never attested on-chain, never counted as
--    income or spending). Idempotent on p_ref.
create or replace function public.demo_set_sim_balance(p_user_id uuid, p_spend bigint, p_saved bigint, p_ref text)
returns public.sim_bank_accounts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_acct public.sim_bank_accounts;
  v_market text;
begin
  if p_spend < 0 or p_saved < 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if p_ref is null or p_ref = '' then
    raise exception 'missing_ref' using errcode = '22023';
  end if;
  select * into v_acct from public.sim_bank_accounts where user_id = p_user_id for update;
  if not found then
    raise exception 'no_sim_account' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.transactions where rail = 'upi_sim' and ref like p_ref || ':%') then
    return v_acct; -- this reset already ran
  end if;
  select market_id into v_market from public.users where id = p_user_id;

  if v_acct.balance_paise <> p_spend then
    insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status)
    values (p_user_id, v_market, 'adjustment', 'demo_reset', p_spend - v_acct.balance_paise, 'INR', 'upi_sim', p_ref || ':spend', 'completed');
  end if;
  if v_acct.savings_paise <> p_saved then
    insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status)
    values (p_user_id, v_market, 'adjustment', 'demo_reset_savings', p_saved - v_acct.savings_paise, 'INR', 'upi_sim', p_ref || ':saved', 'completed');
  end if;
  update public.sim_bank_accounts set balance_paise = p_spend, savings_paise = p_saved, updated_at = now()
   where user_id = p_user_id
  returning * into v_acct;
  return v_acct;
end;
$$;
revoke execute on function public.demo_set_sim_balance(uuid, bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.demo_set_sim_balance(uuid, bigint, bigint, text) to service_role;

-- 3. Live Stellar feed for the staff demo view. One row per outbox transaction: who it belongs to,
--    what it was, its hash, and the seconds from her Yes (the row is created inside the confirm) to
--    the moment chain-worker saw it in a closed ledger. Staff only (JWT app_metadata.role = staff).
create or replace function public.demo_feed(p_market text, p_limit integer default 25)
returns table (
  id bigint, created_at timestamptz, done_at timestamptz, seconds numeric, status text,
  account text, kind text, fn text, tx_kind text, tx_source text, person text,
  amount_minor bigint, currency text, tx_hash text, automatic boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') <> 'staff' then
    raise exception 'staff_only' using errcode = '42501';
  end if;
  if p_market not in ('in', 'ng') then
    raise exception 'invalid_market' using errcode = '22023';
  end if;
  return query
  select o.id, o.created_at, o.done_at,
         case when o.done_at is not null then round(extract(epoch from (o.done_at - o.created_at))::numeric, 1) end,
         o.status,
         case
           when p_market = 'ng' and o.args ->> 'fn' in ('group_contribute', 'group_payout') then 'Ajo pot'
           when p_market = 'ng' and o.args ->> 'fn' in ('request_advance', 'repay') then 'Advance pool'
           when p_market = 'ng' and o.signer = 'agent_ng' then 'Mama Bisi'
           when p_market = 'ng' and o.signer = 'funmi' then 'Funmi'
           when o.kind = 'group_record' then 'Seettu record'
           when o.kind in ('record_advance', 'record_repayment') then 'Advance record'
           when o.kind = 'attest' then coalesce(u.name, 'Her') || '''s record'
           else coalesce(u.name, 'Plus')
         end,
         o.kind, o.args ->> 'fn', t.kind, t.source, coalesce(u.name, cu.name),
         coalesce(t.amount, c.amount, case when o.args ->> 'amount' ~ '^-?[0-9]+$' then (o.args ->> 'amount')::numeric / 100000 end)::bigint,
         coalesce(t.currency, case p_market when 'ng' then 'NGN' else 'INR' end),
         o.tx_hash,
         o.ref like 'group_payout:%' or o.ref like 'cash_out_return:%'
    from public.chain_outbox o
    left join public.transactions t on t.id = case when o.args ->> 'transaction_id' ~ '^[0-9a-f-]{36}$' then (o.args ->> 'transaction_id')::uuid end
    left join public.users u on u.id = t.user_id
    left join public.cash_out_codes c on c.claim_outbox_id = o.id
    left join public.users cu on cu.id = c.user_id
   where o.ref not like 'bench:%'
     and case p_market
           when 'ng' then o.signer in ('funmi', 'agent_ng') or o.args ->> 'fn' = 'group_payout' or u.market_id = 'ng'
           else u.market_id = 'in' or o.kind in ('group_record', 'record_advance', 'record_repayment')
         end
   order by o.id desc
   limit least(greatest(coalesce(p_limit, 25), 1), 100);
end;
$$;
revoke execute on function public.demo_feed(text, integer) from public, anon;
grant execute on function public.demo_feed(text, integer) to authenticated;

-- 4. Warm-up: every 5 minutes the scheduler pings each Edge Function's /health route, but only
--    while the Supabase secret DEMO_WARM is "true" (checked inside the function).
select cron.unschedule(jobid) from cron.job where jobname = 'plus-warm';
select cron.schedule('plus-warm', '*/5 * * * *', $$select public.invoke_plus_function('scheduler/warm')$$);
