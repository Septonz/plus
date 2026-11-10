-- Onboarding (sign-up by voice or on screen, or at an agent), KYC tiers, custodial wallets with
-- keys in Vault, bank transfer in through a simulated partner bank, and paying anyone by phone.

-- ---------------------------------------------------------------------------
-- users: what sign-up collects. The NIN itself is never stored: only an HMAC and the last 4 digits.
-- The selfie is never stored: only that the (simulated) liveness check passed.
-- ---------------------------------------------------------------------------
create sequence public.virtual_account_seq start 10001;

alter table public.users
  add column member_since timestamptz not null default now(),
  add column phone_verified_at timestamptz,
  add column selfie_passed boolean not null default false,
  add column id_hash text check (id_hash ~ '^[0-9a-f]{64}$'),
  add column id_last4 text check (id_last4 ~ '^[0-9]{4}$'),
  add column trusted_contact_name text check (char_length(trusted_contact_name) <= 60),
  add column virtual_account text unique check (virtual_account ~ '^[0-9]{10}$'),
  add column onboarded_via text check (onboarded_via in ('app', 'voice', 'agent')),
  add column onboarded_by uuid references public.helpers (id),
  add column archived_at timestamptz;

create index users_onboarded_by_idx on public.users (onboarded_by) where onboarded_by is not null;

-- The demo people keep what the demo needs: full KYC (tier 2), members for months (advances open
-- after 8 weeks), and Funmi a virtual account for bank transfers in.
update public.users set kyc_tier = 2, selfie_passed = true, phone_verified_at = created_at,
       member_since = now() - interval '20 weeks'
 where name in ('Funmi', 'Selvi');
update public.users set virtual_account = '90' || lpad(nextval('public.virtual_account_seq')::text, 8, '0')
 where market_id = 'ng' and stellar_pub is not null and virtual_account is null;

-- ---------------------------------------------------------------------------
-- onboarding_sessions: a sign-up in progress (before and while the users row exists).
-- Service role only; the app and the voice agent reach it through agent-tools with a signed token.
-- ---------------------------------------------------------------------------
create table public.onboarding_sessions (
  id uuid primary key default gen_random_uuid(),
  market_id text not null check (market_id in ('in', 'ng')),
  name text check (char_length(name) between 1 and 60),
  language text,
  phone text check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  code_hash text check (code_hash ~ '^[0-9a-f]{64}$'),
  code_expires_at timestamptz,
  code_attempts integer not null default 0,
  codes_sent integer not null default 0,
  user_id uuid references public.users (id),
  helper_id uuid references public.helpers (id),
  channel text not null default 'app' check (channel in ('app', 'agent')),
  finished_at timestamptz,
  expires_at timestamptz not null default now() + interval '1 day',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index onboarding_sessions_user_idx on public.onboarding_sessions (user_id) where user_id is not null;
create index onboarding_sessions_helper_idx on public.onboarding_sessions (helper_id) where helper_id is not null;
create trigger onboarding_sessions_updated_at before update on public.onboarding_sessions
  for each row execute function public.set_updated_at();
alter table public.onboarding_sessions enable row level security;
revoke all on public.onboarding_sessions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Custodial keys for wallets created by sign-up live in Vault (never in a table, never logged).
-- chain-worker reads them by signer name; the env secrets (partner, funmi, agent_ng) come first.
-- ---------------------------------------------------------------------------
create or replace function public.wallet_key_get(p_signer text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'stellar_secret_' || p_signer limit 1;
$$;

-- Create a system wallet's key (e.g. anchor_ng) if it has none. Returns the public key only.
create or replace function public.wallet_key_put(p_signer text, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_signer !~ '^[a-z][a-z0-9_]{0,31}$' or p_secret !~ '^S[A-Z2-7]{55}$' then
    raise exception 'bad_key' using errcode = '22023';
  end if;
  if exists (select 1 from vault.secrets where name = 'stellar_secret_' || p_signer) then
    raise exception 'key_exists' using errcode = '23505';
  end if;
  perform vault.create_secret(p_secret, 'stellar_secret_' || p_signer, 'Plus custodial Stellar key (testnet)');
end;
$$;

-- chain_outbox: create_wallet = a partner-sponsored account with NGNT and USDC trustlines.
alter table public.chain_outbox drop constraint chain_outbox_kind_check;
alter table public.chain_outbox add constraint chain_outbox_kind_check
  check (kind in ('attest', 'group_record', 'contract', 'payment', 'claimable_create', 'claimable_claim', 'create_wallet'));

-- ---------------------------------------------------------------------------
-- ng_create_wallet: one atomic step. If she has no wallet yet: store the new key in Vault, set her
-- address, give her a virtual account number, and queue the sponsored account creation on
-- partner's queue. A retry (or a second tap) changes nothing and returns the queued row.
-- ---------------------------------------------------------------------------
create or replace function public.ng_create_wallet(p_user_id uuid, p_pub text, p_secret text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_u public.users;
  v_signer text;
  v_out bigint;
begin
  select * into v_u from public.users where id = p_user_id for update;
  if not found or v_u.archived_at is not null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_u.market_id <> 'ng' then
    raise exception 'no_crypto_in_market' using errcode = 'P0001';
  end if;
  if v_u.stellar_pub is not null then
    select id into v_out from public.chain_outbox where ref = 'create_wallet:' || p_user_id;
    return jsonb_build_object('created', false, 'pub', v_u.stellar_pub, 'outbox_id', v_out, 'virtual_account', v_u.virtual_account);
  end if;
  if p_pub !~ '^G[A-Z2-7]{55}$' or p_secret !~ '^S[A-Z2-7]{55}$' then
    raise exception 'bad_key' using errcode = '22023';
  end if;
  v_signer := 'u_' || replace(left(p_user_id::text, 13), '-', '');
  perform vault.create_secret(p_secret, 'stellar_secret_' || v_signer, 'Plus custodial wallet key (testnet)');
  update public.users
     set stellar_pub = p_pub,
         secret_name = 'STELLAR_SECRET_' || upper(v_signer),
         virtual_account = coalesce(virtual_account, '90' || lpad(nextval('public.virtual_account_seq')::text, 8, '0'))
   where id = p_user_id
  returning * into v_u;
  v_out := public.chain_enqueue_on('partner', 'create_wallet', 'create_wallet:' || p_user_id, jsonb_build_object(
    'pub', p_pub, 'signer', v_signer, 'trustlines', jsonb_build_array('NGNT', 'USDC'),
    'refresh_user_ids', jsonb_build_array(p_user_id)));
  return jsonb_build_object('created', true, 'pub', p_pub, 'outbox_id', v_out, 'virtual_account', v_u.virtual_account);
end;
$$;

-- ---------------------------------------------------------------------------
-- transactions: who was on the other side (a name for the screen; never on-chain).
-- ---------------------------------------------------------------------------
alter table public.transactions add column counterparty text check (char_length(counterparty) <= 80);

-- ---------------------------------------------------------------------------
-- ng_bank_transfer_in: a transfer arrived at her virtual account (simulated partner bank). The
-- partner's anchor account (anchor_ng) sends the same NGNT to her wallet; 10% repays an open
-- advance right after it lands. Idempotent on p_ref.
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
  return jsonb_build_object('transaction_id', v_tx.id, 'created', true, 'outbox_id', v_out, 'repay', v_repay,
                            'repay_transaction_id', v_repay_tx.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Paying someone who has no Plus account: a claimable balance any registered agent can claim,
-- with a code sent to them by SMS (simulated on her screen). Like a cash-out, but for someone else.
-- ---------------------------------------------------------------------------
alter table public.cash_out_codes
  add column recipient_phone text check (recipient_phone ~ '^\+[1-9][0-9]{7,14}$'),
  add column recipient_name text check (char_length(recipient_name) <= 60);
create index cash_out_codes_recipient_idx on public.cash_out_codes (recipient_phone, created_at desc) where recipient_phone is not null;
grant select (recipient_name) on public.cash_out_codes to authenticated;

-- Saved payees can be a phone number (a Plus user or not) as well as a wallet.
alter table public.payees add column phone text check (phone ~ '^\+[1-9][0-9]{7,14}$');
-- A plain unique constraint (null phones stay distinct) so it can be an ON CONFLICT target.
alter table public.payees add constraint payees_user_phone_key unique (user_id, phone);

-- ---------------------------------------------------------------------------
-- ng_execute_pending_action, now with:
--   pay      to another Plus user: her incoming row is written in the same transaction (peer).
--   pay_code to a phone with no Plus account: a claimable balance + a code for the recipient.
-- Otherwise unchanged (see 20261109234058_ng_signed_amounts.sql).
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
    if v_u.market_id <> 'ng' or v_u.stellar_pub is null or v_signer is null or v_u.archived_at is not null then
      raise exception 'no_wallet' using errcode = 'P0001';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'invalid_amount' using errcode = 'P0001';
    end if;

    -- Money leaving her wallet: she must have it now (cache minus what is already on its way).
    if v_a.kind in ('pay', 'pay_code', 'group_contribution', 'cash_out') and public.ng_available(p_user_id) < v_amount then
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

-- ng_available also counts pay-by-code money on its way out.
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
-- Archive a test person whose demo phone number is signing up again: history stays, the number
-- and the login are freed. Only people who signed up through onboarding, on a test number.
-- ---------------------------------------------------------------------------
create or replace function public.archive_demo_user(p_user_id uuid, p_prefix text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_u public.users;
begin
  select * into v_u from public.users where id = p_user_id for update;
  if not found or v_u.onboarded_via is null or v_u.archived_at is not null
     or coalesce(p_prefix, '') = '' or left(v_u.wa_phone, length(p_prefix)) <> p_prefix then
    raise exception 'not_archivable' using errcode = 'P0001';
  end if;
  update public.users
     set archived_at = now(),
         -- a unique, never-dialled placeholder (E.164 shape) so the real test number is free again
         wa_phone = '+99' || lpad((('x' || left(md5(v_u.id::text), 12))::bit(48)::bigint % 10000000000000)::text, 13, '0'),
         auth_user_id = null
   where id = v_u.id;
  update public.pending_actions set status = 'expired', result = jsonb_build_object('ok', false, 'error', 'archived')
   where user_id = v_u.id and status = 'pending';
  return v_u.auth_user_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Live demo feed: new signers (people who signed up, the partner bank's anchor) get names too.
-- ---------------------------------------------------------------------------
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
     and case p_market
           when 'ng' then o.signer in ('funmi', 'agent_ng', 'anchor_ng') or o.args ->> 'fn' = 'group_payout' or u.market_id = 'ng'
                          or s.id is not null or w.id is not null
           else u.market_id = 'in' or o.kind in ('group_record', 'record_advance', 'record_repayment')
         end
   order by o.id desc
   limit least(greatest(coalesce(p_limit, 25), 1), 100);
end;
$$;

revoke execute on function public.wallet_key_get(text) from public, anon, authenticated;
revoke execute on function public.wallet_key_put(text, text) from public, anon, authenticated;
revoke execute on function public.ng_create_wallet(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.ng_bank_transfer_in(uuid, bigint, bigint, text, text) from public, anon, authenticated;
revoke execute on function public.archive_demo_user(uuid, text) from public, anon, authenticated;
grant execute on function public.wallet_key_get(text) to service_role;
grant execute on function public.wallet_key_put(text, text) to service_role;
grant execute on function public.ng_create_wallet(uuid, text, text) to service_role;
grant execute on function public.ng_bank_transfer_in(uuid, bigint, bigint, text, text) to service_role;
grant execute on function public.archive_demo_user(uuid, text) to service_role;
grant usage on sequence public.virtual_account_seq to service_role;
