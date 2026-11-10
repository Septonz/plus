-- Piece 4: the lending model (Nigeria). Loans from a partner lender's account (lending_ng) to her
-- wallet as NGNT through the chain outbox; repayments (10% of every money-in, a two-weekly
-- minimum, or "repay now") go back as NGNT from her wallet. Loan state lives here; piece 8 mirrors
-- it on the plus_credit contract. Rules (amounts, ladder, weights) are in the market pack.
--
--   system_wallets       public addresses of system accounts (anchor_ng, lending_ng)
--   assets               what she owns (piece 5 adds registering and verifying); a verified asset is collateral
--   credit_history_seed  compressed demo history: weekly summaries for the demo people's earlier weeks
--   loans, loan_events   one open loan at a time; every step of it logged
--   users.borrowing_frozen_until

-- ---------------------------------------------------------------------------
-- System accounts' public addresses (keys stay in Vault; written by scheduler/provision)
-- ---------------------------------------------------------------------------
create table public.system_wallets (
  signer text primary key check (signer ~ '^[a-z_]{3,32}$'),
  pub text not null check (pub ~ '^G[A-Z2-7]{55}$'),
  created_at timestamptz not null default now()
);
alter table public.system_wallets enable row level security;
revoke all on public.system_wallets from anon, authenticated;

alter table public.users add column borrowing_frozen_until timestamptz;

-- ---------------------------------------------------------------------------
-- Assets
-- ---------------------------------------------------------------------------
create table public.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  type text not null check (type in ('stock', 'tools', 'machine', 'motorcycle', 'livestock')),
  description text not null check (char_length(description) between 2 and 120),
  estimated_value bigint not null check (estimated_value > 0),          -- kobo
  level text not null default 'registered'
    check (level in ('registered', 'evidence_verified', 'community_verified', 'independently_verified')),
  status text not null default 'active'
    check (status in ('active', 'under_review', 'lost', 'stolen', 'damaged', 'released')),
  -- Internal, for lenders only: never selectable by the app (column grants below).
  confidence smallint not null default 10 check (confidence between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assets_user_idx on public.assets (user_id, created_at desc);
create trigger assets_updated_at before update on public.assets for each row execute function public.set_updated_at();
alter table public.assets enable row level security;
revoke all on public.assets from anon, authenticated;
grant select (id, user_id, type, description, estimated_value, level, status, created_at, updated_at) on public.assets to authenticated;
create policy assets_own_read on public.assets
  for select to authenticated using (user_id = (select public.current_plus_user_id()));

-- ---------------------------------------------------------------------------
-- Compressed demo history (weekly summaries). Real weeks come from transactions.
-- ---------------------------------------------------------------------------
create table public.credit_history_seed (
  user_id uuid not null references public.users (id) on delete cascade,
  week_index integer not null check (week_index >= 1),
  money_in bigint not null default 0 check (money_in >= 0),          -- kobo
  qualifying_tx integer not null default 0 check (qualifying_tx >= 0),
  saved bigint not null default 0 check (saved >= 0),                -- kobo (ajo contributions)
  primary key (user_id, week_index)
);
alter table public.credit_history_seed enable row level security;
revoke all on public.credit_history_seed from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Loans
-- ---------------------------------------------------------------------------
create table public.loans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  lender text not null default 'lending_ng',
  step smallint not null check (step between 0 and 9),
  principal bigint not null check (principal > 0),                   -- kobo
  cost bigint not null check (cost >= 0),
  total bigint generated always as (principal + cost) stored,
  repay_bps integer not null check (repay_bps between 0 and 10000),
  minimum bigint not null check (minimum > 0),
  every_days integer not null check (every_days between 1 and 90),
  collateral_asset_id uuid references public.assets (id),
  collateral_pct integer not null check (collateral_pct between 0 and 300),
  status text not null default 'active' check (status in ('active', 'late', 'restructured', 'repaid', 'default')),
  period_start timestamptz not null default now(),
  next_due_at timestamptz not null,
  grace_until timestamptz,
  missed integer not null default 0,
  extended_once boolean not null default false,
  restructured_once boolean not null default false,
  borrowing_paused boolean not null default false,
  closed_by_reset boolean not null default false,                   -- demo reset settled it: no ladder step
  action_id uuid unique references public.pending_actions (id),
  disburse_tx uuid references public.transactions (id),
  created_at timestamptz not null default now(),
  repaid_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index loans_one_open on public.loans (user_id) where status in ('active', 'late', 'restructured');
create index loans_due_idx on public.loans (next_due_at) where status in ('active', 'late', 'restructured');
create trigger loans_updated_at before update on public.loans for each row execute function public.set_updated_at();
alter table public.loans enable row level security;
revoke all on public.loans from anon, authenticated;
grant select on public.loans to authenticated;
create policy loans_own_read on public.loans
  for select to authenticated using (user_id = (select public.current_plus_user_id()));

create table public.loan_events (
  id bigint generated always as identity primary key,
  loan_id uuid not null references public.loans (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  kind text not null check (kind in ('disbursed', 'repayment', 'minimum_paid', 'reminder', 'late', 'restructured',
                                     'extended', 'frozen', 'repaid', 'reset')),
  amount bigint,
  note text check (char_length(note) <= 200),
  created_at timestamptz not null default now()
);
create index loan_events_loan_idx on public.loan_events (loan_id, created_at desc);
alter table public.loan_events enable row level security;
revoke all on public.loan_events from anon, authenticated;
grant select on public.loan_events to authenticated;
create policy loan_events_own_read on public.loan_events
  for select to authenticated using (user_id = (select public.current_plus_user_id()));

-- ---------------------------------------------------------------------------
-- Her weeks with Plus: week 1 starts at member_since. Real weeks from completed transactions,
-- earlier demo weeks from credit_history_seed. Circular or back-and-forth transfers don't count:
-- money from a Plus user she also paid within 7 days (either way), and money she sent to someone
-- who paid her within 7 days. Loans, repayments, advances and demo-reset adjustments never count.
-- ---------------------------------------------------------------------------
create or replace function public.ng_credit_weeks(p_user_id uuid)
returns table (week integer, money_in bigint, qualifying_tx integer, saved bigint)
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
       and tx.kind in ('incoming', 'pay', 'group_contribution', 'cash_out')
  ),
  real as (
    select wk as week,
           coalesce(sum(amount) filter (where kind = 'incoming' and not circular), 0)::bigint as money_in,
           (count(*) filter (where not circular))::integer as qualifying_tx,
           coalesce(sum(-amount) filter (where kind = 'group_contribution'), 0)::bigint as saved
      from t where wk >= 1 group by wk
  )
  select week, sum(money_in)::bigint, sum(qualifying_tx)::integer, sum(saved)::bigint
    from (select * from real
          union all
          select s.week_index, s.money_in, s.qualifying_tx, s.saved from public.credit_history_seed s where s.user_id = p_user_id) w
   group by week order by week;
$$;
revoke execute on function public.ng_credit_weeks(uuid) from public, anon, authenticated;

-- Her loans with balances: repaid (on Stellar), in flight, paid this period, outstanding.
create or replace function public.ng_loans(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(l) || jsonb_build_object(
           'repaid', r.repaid, 'in_flight', r.in_flight, 'period_paid', r.period_paid,
           'outstanding', l.total - r.repaid - r.in_flight,
           'disbursed', coalesce(d.status, 'pending'), 'disburse_hash', d.chain_tx_hash) order by l.created_at desc), '[]'::jsonb)
    from public.loans l
    left join public.transactions d on d.id = l.disburse_tx
    cross join lateral (
      select coalesce(sum(-t.amount) filter (where t.status = 'completed'), 0)::bigint as repaid,
             coalesce(sum(-t.amount) filter (where t.status = 'pending'), 0)::bigint as in_flight,
             coalesce(sum(-t.amount) filter (where t.status <> 'failed' and t.created_at >= l.period_start), 0)::bigint as period_paid
        from public.transactions t
       where t.user_id = l.user_id and t.kind = 'loan_repay' and t.source = l.id::text
    ) r
   where l.user_id = p_user_id;
$$;
revoke execute on function public.ng_loans(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- A repayment: NGNT from her wallet to the lending account, at most what is still owed.
-- Idempotent on p_ref. p_after: wait for that outbox row (the money-in it comes from).
-- Returns the transaction id, or null when there is no open loan or nothing is owed.
-- ---------------------------------------------------------------------------
create or replace function public.ng_loan_repay(p_user_id uuid, p_amount bigint, p_ref text, p_after bigint, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_u public.users;
  v_l public.loans;
  v_lend text;
  v_owed bigint;
  v_amt bigint;
  v_tx uuid;
begin
  select id into v_tx from public.transactions where rail = 'stellar' and ref = 'loan_repay:' || p_ref;
  if found then
    return v_tx;
  end if;
  select * into v_l from public.loans where user_id = p_user_id and status in ('active', 'late', 'restructured') for update;
  if not found then
    return null;
  end if;
  select pub into v_lend from public.system_wallets where signer = v_l.lender;
  select * into v_u from public.users where id = p_user_id;
  if v_lend is null or public.signer_of(v_u.secret_name) is null then
    return null;
  end if;
  select v_l.total - coalesce(sum(-amount), 0) into v_owed
    from public.transactions where user_id = p_user_id and kind = 'loan_repay' and source = v_l.id::text and status <> 'failed';
  v_amt := least(coalesce(p_amount, 0), v_owed);
  if v_amt <= 0 then
    return null;
  end if;
  insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status, counterparty)
  values (p_user_id, 'ng', 'loan_repay', v_l.id::text, -v_amt, 'NGN', 'stellar', 'loan_repay:' || p_ref, 'pending', 'Partner lender')
  returning id into v_tx;
  perform public.chain_enqueue_on(public.signer_of(v_u.secret_name), 'payment', 'loan_repay:' || p_ref, jsonb_build_object(
    'asset', 'NGNT', 'to', v_lend, 'amount', (v_amt * 100000)::text, 'transaction_id', v_tx), p_after);
  insert into public.loan_events (loan_id, user_id, kind, amount, note)
  values (v_l.id, p_user_id, case when p_reason = 'two_weekly_minimum' then 'minimum_paid' else 'repayment' end, v_amt, p_reason);
  return v_tx;
end;
$$;
revoke execute on function public.ng_loan_repay(uuid, bigint, text, bigint, text) from public, anon, authenticated;

-- 10% (the loan's repay_bps) of a money-in repays her open loan, after the money-in lands.
create or replace function public.ng_loan_repay_from_money_in(p_user_id uuid, p_money_in bigint, p_ref text, p_after bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bps integer;
begin
  select repay_bps into v_bps from public.loans where user_id = p_user_id and status in ('active', 'late', 'restructured');
  if not found or v_bps <= 0 then
    return null;
  end if;
  return public.ng_loan_repay(p_user_id, (p_money_in * v_bps) / 10000, p_ref, p_after, 'money_in');
end;
$$;
revoke execute on function public.ng_loan_repay_from_money_in(uuid, bigint, text, bigint) from public, anon, authenticated;

-- Fully repaid on Stellar: the loan closes, borrowing opens again, the ladder moves up.
create or replace function public.loans_on_repayment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l public.loans;
  v_paid bigint;
begin
  select * into v_l from public.loans where id = new.source::uuid and status in ('active', 'late', 'restructured') for update;
  if not found then
    return new;
  end if;
  select coalesce(sum(-amount), 0) into v_paid
    from public.transactions where user_id = v_l.user_id and kind = 'loan_repay' and source = v_l.id::text and status = 'completed';
  if v_paid >= v_l.total then
    update public.loans set status = 'repaid', repaid_at = now(), borrowing_paused = false, grace_until = null where id = v_l.id;
    update public.users set borrowing_frozen_until = null where id = v_l.user_id;
    insert into public.loan_events (loan_id, user_id, kind, amount) values (v_l.id, v_l.user_id, 'repaid', v_l.total);
  end if;
  return new;
end;
$$;
create trigger transactions_loan_repaid after update of status on public.transactions
  for each row when (new.kind = 'loan_repay' and new.status = 'completed' and old.status is distinct from 'completed')
  execute function public.loans_on_repayment();

-- ng_available also counts loan repayments on their way out.
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
                      and kind in ('pay', 'group_contribution', 'cash_out', 'repay', 'loan_repay')), 0);
$$;

-- ---------------------------------------------------------------------------
-- The two-weekly minimum (scheduler, every minute). For each open loan whose date has come:
--   paid enough this period             -> next period
--   not yet, but her wallet has it      -> the rest is repaid now, next period
--   not enough in her wallet            -> a reminder and p_grace_days of grace; after the grace,
--                                          late (restructure offered); a second miss freezes new
--                                          borrowing until the loan is repaid.
-- Nobody else is ever contacted. Idempotent per loan and due date.
-- ---------------------------------------------------------------------------
create or replace function public.ng_loan_minimums(p_grace_days integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l public.loans;
  v_paid bigint;
  v_owed bigint;
  v_need bigint;
  v_paid_n integer := 0;
  v_reminded integer := 0;
  v_late integer := 0;
begin
  for v_l in
    select * from public.loans where status in ('active', 'late', 'restructured') and next_due_at <= now() for update skip locked
  loop
    select coalesce(sum(-amount) filter (where created_at >= v_l.period_start), 0), v_l.total - coalesce(sum(-amount), 0)
      into v_paid, v_owed
      from public.transactions where user_id = v_l.user_id and kind = 'loan_repay' and source = v_l.id::text and status <> 'failed';
    v_need := least(v_l.minimum - v_paid, v_owed);
    if v_need > 0 and public.ng_available(v_l.user_id) >= v_need then
      perform public.ng_loan_repay(v_l.user_id, v_need, 'minimum:' || v_l.id || ':' || to_char(v_l.next_due_at, 'YYYYMMDDHH24MISS'),
                                   null, 'two_weekly_minimum');
      v_need := 0;
      v_paid_n := v_paid_n + 1;
    end if;
    if v_need <= 0 then
      update public.loans
         set period_start = next_due_at, next_due_at = next_due_at + make_interval(days => every_days), grace_until = null,
             status = case when status = 'late' then (case when restructured_once then 'restructured' else 'active' end) else status end
       where id = v_l.id;
    elsif v_l.grace_until is null then
      update public.loans set grace_until = now() + make_interval(days => p_grace_days) where id = v_l.id;
      insert into public.loan_events (loan_id, user_id, kind, amount, note)
      values (v_l.id, v_l.user_id, 'reminder', v_need, 'payment due; grace period started');
      v_reminded := v_reminded + 1;
    elsif now() >= v_l.grace_until then
      update public.loans
         set status = 'late', missed = missed + 1, grace_until = null,
             period_start = next_due_at, next_due_at = next_due_at + make_interval(days => every_days)
       where id = v_l.id;
      insert into public.loan_events (loan_id, user_id, kind, amount, note) values (v_l.id, v_l.user_id, 'late', v_need, 'restructure offered');
      if v_l.missed + 1 >= 2 then
        update public.users set borrowing_frozen_until = 'infinity' where id = v_l.user_id;
        insert into public.loan_events (loan_id, user_id, kind, note) values (v_l.id, v_l.user_id, 'frozen', 'new borrowing frozen until repaid');
      end if;
      v_late := v_late + 1;
    end if;
  end loop;
  return jsonb_build_object('minimums_paid', v_paid_n, 'reminders', v_reminded, 'late', v_late);
end;
$$;
revoke execute on function public.ng_loan_minimums(integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- ng_bank_transfer_in, now also repaying 10% to an open loan (after the money lands).
-- ---------------------------------------------------------------------------
create or replace function public.ng_bank_transfer_in(p_user_id uuid, p_amount bigint, p_repay bigint, p_ref text, p_sender text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_u public.users;
  v_tx public.transactions;
  v_repay_tx public.transactions;
  v_out bigint;
  v_out2 bigint;
  v_loan_tx uuid;
  v_repay bigint := least(greatest(coalesce(p_repay, 0), 0), p_amount);
begin
  if p_amount is null or p_amount <= 0 or coalesce(p_ref, '') !~ '^[A-Za-z0-9_-]{8,80}$' then
    raise exception 'invalid_amount' using errcode = 'P0001';
  end if;
  select * into v_tx from public.transactions where rail = 'stellar' and ref = 'bank_in:' || p_ref;
  if found then
    return jsonb_build_object('transaction_id', v_tx.id, 'created', false);
  end if;
  select * into v_u from public.users where id = p_user_id;
  if not found or v_u.market_id <> 'ng' or v_u.stellar_pub is null or v_u.archived_at is not null then
    raise exception 'no_wallet' using errcode = 'P0001';
  end if;
  insert into public.transactions (user_id, market_id, kind, source, amount, currency, rail, ref, status, counterparty)
  values (p_user_id, 'ng', 'incoming', 'bank', p_amount, 'NGN', 'stellar', 'bank_in:' || p_ref, 'pending', left(p_sender, 80))
  returning * into v_tx;
  v_out := public.chain_enqueue_on('anchor_ng', 'payment', 'bank_in:' || p_ref, jsonb_build_object(
    'asset', 'NGNT', 'to', v_u.stellar_pub, 'amount', (p_amount * 100000)::text, 'transaction_id', v_tx.id));
  if v_repay > 0 then
    insert into public.transactions (user_id, market_id, kind, amount, currency, rail, ref, status)
    values (p_user_id, 'ng', 'repay', -v_repay, 'NGN', 'stellar', 'repay:bank_in:' || p_ref, 'pending')
    returning * into v_repay_tx;
    v_out2 := public.chain_enqueue_on(public.signer_of(v_u.secret_name), 'contract', 'repay:bank_in:' || p_ref, jsonb_build_object(
      'fn', 'repay',
      'args', jsonb_build_array(jsonb_build_object('t', 'address', 'v', v_u.stellar_pub),
                                jsonb_build_object('t', 'i128', 'v', (v_repay * 100000)::text)),
      'transaction_id', v_repay_tx.id), v_out);
  end if;
  v_loan_tx := public.ng_loan_repay_from_money_in(p_user_id, p_amount, 'bank_in:' || p_ref, v_out);
  return jsonb_build_object('transaction_id', v_tx.id, 'created', true, 'outbox_id', v_out, 'repay', v_repay,
                            'repay_transaction_id', v_repay_tx.id, 'loan_repay_transaction_id', v_loan_tx);
end;
$$;

-- ---------------------------------------------------------------------------
-- ng_execute_pending_action, now with loans:
--   loan             the lending account sends the principal to her wallet; the loan row opens
--   loan_repay       "repay now": from her wallet to the lending account
--   loan_extension   "I need more time": the next minimum moves; new borrowing pauses
--   loan_restructure a smaller minimum over a longer time
-- and 10% of every money-in (agent cash-in, a payment from another Plus user) repays an open loan.
-- Otherwise unchanged (see 20261110030443_onboarding_money_in.sql).
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
    if v_u.market_id <> 'ng' or v_u.stellar_pub is null or v_signer is null or v_u.archived_at is not null then
      raise exception 'no_wallet' using errcode = 'P0001';
    end if;
    if v_a.kind not in ('loan_extension', 'loan_restructure') and (v_amount is null or v_amount <= 0) then
      raise exception 'invalid_amount' using errcode = 'P0001';
    end if;

    -- Money leaving her wallet: she must have it now (cache minus what is already on its way).
    if v_a.kind in ('pay', 'pay_code', 'group_contribution', 'cash_out', 'loan_repay') and public.ng_available(p_user_id) < v_amount then
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
        v_result := jsonb_build_object('loan_id', v_loan.id, 'cost', v_loan.cost, 'total', v_loan.total);

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

-- The app sees her loans and their steps live.
alter publication supabase_realtime add table public.loans;
