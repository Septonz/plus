-- /demo is open to anyone (no staff login). demo_feed keeps the staff view as it was; without a staff
-- login it returns only rows that involve demo accounts alone, so no real or guest trader's name or
-- payment appears on the public projector view. Testnet hashes are public on Stellar anyway.
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
declare
  v_staff boolean := coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') = 'staff';
begin
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
           when p_market = 'ng' and o.kind = 'create_wallet' then 'New wallet'
           when p_market = 'ng' and o.signer = 'anchor_ng' then 'Partner bank'
           when p_market = 'ng' and o.signer = 'agent_ng' then 'Mama Bisi'
           when p_market = 'ng' and o.signer = 'funmi' then 'Funmi'
           when p_market = 'ng' and s.name is not null then s.name
           when o.kind = 'group_record' then 'Seettu record'
           when o.kind in ('record_advance', 'record_repayment') then 'Advance record'
           when o.kind = 'attest' then coalesce(u.name, 'Her') || '''s record'
           else coalesce(u.name, 'Plus')
         end,
         o.kind, o.args ->> 'fn', t.kind, t.source, coalesce(u.name, cu.name, w.name),
         coalesce(t.amount, c.amount, case when o.args ->> 'amount' ~ '^-?[0-9]+$' then (o.args ->> 'amount')::numeric / 100000 end)::bigint,
         coalesce(t.currency, case p_market when 'ng' then 'NGN' else 'INR' end),
         o.tx_hash,
         o.ref like 'group_payout:%' or o.ref like 'cash_out_return:%'
    from public.chain_outbox o
    left join public.transactions t on t.id = case when o.args ->> 'transaction_id' ~ '^[0-9a-f-]{36}$' then (o.args ->> 'transaction_id')::uuid end
    left join public.users u on u.id = t.user_id
    left join public.cash_out_codes c on c.claim_outbox_id = o.id
    left join public.users cu on cu.id = c.user_id
    left join public.users s on o.signer like 'u\_%' and public.signer_of(s.secret_name) = o.signer
    left join public.users w on o.kind = 'create_wallet' and w.stellar_pub = o.args ->> 'pub'
   where o.ref not like 'bench:%'
     -- Anyone may watch /demo now: without a staff login, only rows whose people are all demo
     -- accounts (Funmi, Selvi, Mama Bisi's customers who are demo people); no real or guest names.
     and (v_staff or (coalesce(u.demo_login, true) and coalesce(s.demo_login, true)
                      and coalesce(cu.demo_login, true) and coalesce(w.demo_login, true)
                      and (u.id is not null or s.id is not null or w.id is not null or cu.id is not null
                           or o.signer in ('funmi', 'agent_ng', 'anchor_ng')
                           or o.kind in ('group_record', 'record_advance', 'record_repayment'))))
     and case p_market
           when 'ng' then o.signer in ('funmi', 'agent_ng', 'anchor_ng') or o.args ->> 'fn' = 'group_payout' or u.market_id = 'ng'
                          or s.id is not null or w.id is not null
           else u.market_id = 'in' or o.kind in ('group_record', 'record_advance', 'record_repayment')
         end
   order by o.id desc
   limit least(greatest(coalesce(p_limit, 25), 1), 100);
end;
$$;

revoke execute on function public.demo_feed(text, integer) from public;
grant execute on function public.demo_feed(text, integer) to anon, authenticated;
