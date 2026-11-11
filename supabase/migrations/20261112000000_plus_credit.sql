-- Piece 8: the plus_credit contract (contracts/plus_credit), the public record of loans, assets
-- and vouches. Every loan and asset change is written to it through the outbox (partner's queue),
-- so a lender can read her record from Stellar without trusting Plus.
--
-- What goes on-chain: 32-byte references only. Each is HMAC-SHA256 with a key kept in Vault
-- (plus_ref_secret, created here on first use, never leaves the database):
--   borrower   = hmac('user:'   || users.id)
--   loan       = hmac('loan:'   || loans.id)
--   asset      = hmac('asset:'  || assets.id)
--   verification = hmac('verify:' || asset id, level, evidence hash, inspection time, witnesses)
--   payment    = the Stellar hash of the NGNT repayment itself (public anyway)
-- Never names, phone numbers, photos, places, descriptions or ID numbers. Amounts: kobo x 100,000
-- (i128, 7 decimals).

-- partner signs every plus_credit write (its public address; the key stays in Supabase secrets).
insert into public.system_wallets (signer, pub)
values ('partner', 'GCHDENOIJ5JFA3JU3OPW3LZSLHR57HCOHA7ZYQSRYG6MHHOFSAM4CWWZ')
on conflict (signer) do nothing;

-- The last plus_credit transaction for each loan and asset: the app's "Verified on Stellar" tick.
alter table public.loans add column credit_tx_hash text check (credit_tx_hash ~ '^[0-9a-f]{64}$');
alter table public.assets add column credit_tx_hash text check (credit_tx_hash ~ '^[0-9a-f]{64}$');
grant select (credit_tx_hash) on public.assets to authenticated;

create index chain_outbox_credit_loan_idx on public.chain_outbox ((args ->> 'loan_id')) where args ->> 'contract' = 'credit';

-- ---------------------------------------------------------------------------
-- References
-- ---------------------------------------------------------------------------
create or replace function private.credit_ref(p_input text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'plus_ref_secret';
  if v_key is null then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'plus_ref_secret',
      'Key for the 32-byte references written to plus_credit (piece 8). Never leaves the database.');
    select decrypted_secret into v_key from vault.decrypted_secrets where name = 'plus_ref_secret';
  end if;
  return encode(extensions.hmac(p_input, v_key, 'sha256'), 'hex');
end;
$$;
revoke execute on function private.credit_ref(text) from public, anon, authenticated;

-- Her on-chain reference (also what /verify reads by, piece 9).
create or replace function public.credit_borrower_ref(p_user_id uuid)
returns text
language sql
volatile
security definer
set search_path = ''
as $$ select private.credit_ref('user:' || p_user_id::text) $$;
revoke execute on function public.credit_borrower_ref(uuid) from public, anon, authenticated;
grant execute on function public.credit_borrower_ref(uuid) to service_role;

create or replace function private.credit_verification(p_a public.assets)
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select private.credit_ref('verify:' || p_a.id::text || ':' || p_a.level || ':' || coalesce(p_a.evidence_hash, '') || ':' ||
    coalesce(p_a.inspected_at::text, '') || ':' ||
    coalesce((select string_agg(w.id::text, ',' order by w.id) from public.asset_witnesses w
               where w.asset_id = p_a.id and w.status = 'confirmed'), ''))
$$;
revoke execute on function private.credit_verification(public.assets) from public, anon, authenticated;

create or replace function private.credit_level(p_level text)
returns integer language sql immutable set search_path = '' as $$
  select case p_level when 'registered' then 0 when 'evidence_verified' then 1
                      when 'community_verified' then 2 when 'independently_verified' then 3 end
$$;
create or replace function private.credit_asset_status(p_status text)
returns integer language sql immutable set search_path = '' as $$
  select case p_status when 'active' then 0 when 'under_review' then 1 when 'lost' then 2
                       when 'stolen' then 3 when 'damaged' then 4 when 'released' then 5 end
$$;
-- Repaid comes on-chain from the repayments themselves; a loan the demo reset settled is Cancelled.
create or replace function private.credit_loan_status(p_status text, p_closed_by_reset boolean)
returns integer language sql immutable set search_path = '' as $$
  select case
    when p_status = 'repaid' and p_closed_by_reset then 5
    else case p_status when 'active' then 0 when 'late' then 1 when 'restructured' then 2 when 'default' then 4 end
  end
$$;

-- ---------------------------------------------------------------------------
-- One plus_credit call on partner's queue. The first argument is always the caller (partner).
-- Returns the outbox row (the existing one when this ref was already enqueued), or null when
-- partner isn't configured.
-- ---------------------------------------------------------------------------
create or replace function private.credit_enqueue(p_ref text, p_fn text, p_args jsonb, p_ids jsonb, p_after bigint default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_partner text;
begin
  select pub into v_partner from public.system_wallets where signer = 'partner';
  if v_partner is null then
    return null;
  end if;
  return public.chain_enqueue_on('partner', 'contract', 'credit:' || p_ref,
    jsonb_build_object('contract', 'credit', 'fn', p_fn,
      'args', jsonb_build_array(jsonb_build_object('t', 'address', 'v', v_partner)) || p_args) || p_ids,
    p_after);
end;
$$;
revoke execute on function private.credit_enqueue(text, text, jsonb, jsonb, bigint) from public, anon, authenticated;

create or replace function private.credit_asset_register(p_a public.assets)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.credit_enqueue('asset:' || p_a.id, 'asset_register', jsonb_build_array(
    jsonb_build_object('t', 'bytes32', 'v', private.credit_ref('asset:' || p_a.id::text)),
    jsonb_build_object('t', 'bytes32', 'v', private.credit_ref('user:' || p_a.user_id::text)),
    jsonb_build_object('t', 'bytes32', 'v', private.credit_verification(p_a)),
    jsonb_build_object('t', 'u32', 'v', private.credit_level(p_a.level))),
    jsonb_build_object('asset_id', p_a.id));
end;
$$;
revoke execute on function private.credit_asset_register(public.assets) from public, anon, authenticated;

-- The register row of an asset, enqueued now if it never was.
create or replace function private.credit_asset_row(p_asset_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_a public.assets;
begin
  select id into v_id from public.chain_outbox where ref = 'credit:asset:' || p_asset_id;
  if v_id is null then
    select * into v_a from public.assets where id = p_asset_id;
    if found then
      v_id := private.credit_asset_register(v_a);
    end if;
  end if;
  return v_id;
end;
$$;
revoke execute on function private.credit_asset_row(uuid) from public, anon, authenticated;

create or replace function private.credit_asset_level(p_a public.assets)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_verify text := private.credit_verification(p_a);
begin
  return private.credit_enqueue('asset_level:' || p_a.id || ':' || p_a.level || ':' || left(v_verify, 16), 'asset_set_level',
    jsonb_build_array(
      jsonb_build_object('t', 'bytes32', 'v', private.credit_ref('asset:' || p_a.id::text)),
      jsonb_build_object('t', 'u32', 'v', private.credit_level(p_a.level)),
      jsonb_build_object('t', 'bytes32', 'v', v_verify)),
    jsonb_build_object('asset_id', p_a.id), private.credit_asset_row(p_a.id));
end;
$$;
revoke execute on function private.credit_asset_level(public.assets) from public, anon, authenticated;

create or replace function private.credit_asset_status_row(p_a public.assets)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  select count(*) into v_n from public.chain_outbox where ref like 'credit:asset_status:' || p_a.id || ':%';
  return private.credit_enqueue('asset_status:' || p_a.id || ':' || p_a.status || ':' || v_n, 'asset_set_status',
    jsonb_build_array(
      jsonb_build_object('t', 'bytes32', 'v', private.credit_ref('asset:' || p_a.id::text)),
      jsonb_build_object('t', 'u32', 'v', private.credit_asset_status(p_a.status))),
    jsonb_build_object('asset_id', p_a.id), private.credit_asset_row(p_a.id));
end;
$$;
revoke execute on function private.credit_asset_status_row(public.assets) from public, anon, authenticated;

create or replace function private.credit_loan_open(p_l public.loans)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lender text;
  v_after bigint;
begin
  select pub into v_lender from public.system_wallets where signer = p_l.lender;
  if v_lender is null then
    return null;
  end if;
  if p_l.collateral_asset_id is not null then
    v_after := private.credit_asset_row(p_l.collateral_asset_id);
  end if;
  return private.credit_enqueue('loan:' || p_l.id, 'loan_open', jsonb_build_array(
    jsonb_build_object('t', 'bytes32', 'v', private.credit_ref('loan:' || p_l.id::text)),
    jsonb_build_object('t', 'bytes32', 'v', private.credit_ref('user:' || p_l.user_id::text)),
    jsonb_build_object('t', 'address', 'v', v_lender),
    jsonb_build_object('t', 'i128', 'v', (p_l.principal * 100000)::text),
    jsonb_build_object('t', 'i128', 'v', (p_l.cost * 100000)::text),
    jsonb_build_object('t', 'u32', 'v', p_l.repay_bps),
    jsonb_build_object('t', 'i128', 'v', (p_l.minimum * 100000)::text),
    jsonb_build_object('t', 'opt_bytes32', 'v',
      case when p_l.collateral_asset_id is null then null else private.credit_ref('asset:' || p_l.collateral_asset_id::text) end),
    jsonb_build_object('t', 'u32', 'v', p_l.collateral_pct)),
    jsonb_build_object('loan_id', p_l.id), v_after);
end;
$$;
revoke execute on function private.credit_loan_open(public.loans) from public, anon, authenticated;

create or replace function private.credit_loan_row(p_loan_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_l public.loans;
begin
  select id into v_id from public.chain_outbox where ref = 'credit:loan:' || p_loan_id;
  if v_id is null then
    select * into v_l from public.loans where id = p_loan_id;
    if found then
      v_id := private.credit_loan_open(v_l);
    end if;
  end if;
  return v_id;
end;
$$;
revoke execute on function private.credit_loan_row(uuid) from public, anon, authenticated;

create or replace function private.credit_loan_repay(p_t public.transactions)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.credit_enqueue('repay:' || p_t.id, 'loan_repay', jsonb_build_array(
    jsonb_build_object('t', 'bytes32', 'v', private.credit_ref('loan:' || p_t.source)),
    jsonb_build_object('t', 'i128', 'v', (-p_t.amount * 100000)::text),
    jsonb_build_object('t', 'bytes32', 'v',
      case when p_t.chain_tx_hash ~ '^[0-9a-f]{64}$' then p_t.chain_tx_hash else private.credit_ref('payment:' || p_t.id::text) end)),
    jsonb_build_object('loan_id', p_t.source), private.credit_loan_row(p_t.source::uuid));
end;
$$;
revoke execute on function private.credit_loan_repay(public.transactions) from public, anon, authenticated;

create or replace function private.credit_loan_status_row(p_l public.loans)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status integer := private.credit_loan_status(p_l.status, p_l.closed_by_reset);
  v_n integer;
begin
  if v_status is null then
    return null; -- repaid by her: the repayments close it on-chain
  end if;
  select count(*) into v_n from public.chain_outbox where ref like 'credit:loan_status:' || p_l.id || ':%';
  return private.credit_enqueue('loan_status:' || p_l.id || ':' || v_status || ':' || v_n, 'loan_set_status', jsonb_build_array(
    jsonb_build_object('t', 'bytes32', 'v', private.credit_ref('loan:' || p_l.id::text)),
    jsonb_build_object('t', 'u32', 'v', v_status)),
    jsonb_build_object('loan_id', p_l.id), private.credit_loan_row(p_l.id));
end;
$$;
revoke execute on function private.credit_loan_status_row(public.loans) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Triggers: every loan and asset change
-- ---------------------------------------------------------------------------
create or replace function private.credit_on_asset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.credit_asset_register(new);
    return new;
  end if;
  if new.level is distinct from old.level or new.evidence_hash is distinct from old.evidence_hash
     or new.inspected_at is distinct from old.inspected_at then
    perform private.credit_asset_level(new);
  end if;
  if new.status is distinct from old.status then
    perform private.credit_asset_status_row(new);
  end if;
  return new;
end;
$$;
create trigger assets_credit after insert or update of level, status, evidence_hash, inspected_at on public.assets
  for each row execute function private.credit_on_asset();

create or replace function private.credit_on_loan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.credit_loan_open(new);
  elsif new.status is distinct from old.status then
    perform private.credit_loan_status_row(new);
  end if;
  return new;
end;
$$;
create trigger loans_credit after insert or update of status on public.loans
  for each row execute function private.credit_on_loan();

-- A repayment that landed on Stellar (fires before transactions_loan_repaid, so the loan is open).
create or replace function private.credit_on_repayment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.loans where id = new.source::uuid and not closed_by_reset) then
    perform private.credit_loan_repay(new);
  end if;
  return new;
end;
$$;
create trigger transactions_credit_repay after update of status on public.transactions
  for each row when (new.kind = 'loan_repay' and new.status = 'completed' and old.status is distinct from 'completed')
  execute function private.credit_on_repayment();

-- Done on Stellar: the tick links to that transaction.
create or replace function private.credit_on_done()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.args ? 'loan_id' then
    update public.loans set credit_tx_hash = new.tx_hash where id = (new.args ->> 'loan_id')::uuid;
  end if;
  if new.args ? 'asset_id' then
    update public.assets set credit_tx_hash = new.tx_hash where id = (new.args ->> 'asset_id')::uuid;
  end if;
  return new;
end;
$$;
create trigger chain_outbox_credit_done after update of status on public.chain_outbox
  for each row when (new.status = 'done' and old.status is distinct from 'done' and new.args ->> 'contract' = 'credit')
  execute function private.credit_on_done();

revoke execute on function private.credit_on_asset() from public, anon, authenticated;
revoke execute on function private.credit_on_loan() from public, anon, authenticated;
revoke execute on function private.credit_on_repayment() from public, anon, authenticated;
revoke execute on function private.credit_on_done() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Backfill: every existing asset and loan, in the order they happened, so /verify has real
-- history from day one. Safe to run again (each write has a fixed ref; status rows are no-ops
-- on-chain when nothing changed).
-- ---------------------------------------------------------------------------
create or replace function public.credit_backfill()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.assets;
  v_l public.loans;
  v_t public.transactions;
  v_assets integer := 0;
  v_loans integer := 0;
  v_repays integer := 0;
  v_status integer := 0;
begin
  -- 1. Every asset, registered at the level it has now (status follows in step 3).
  for v_a in select * from public.assets order by created_at loop
    perform private.credit_asset_row(v_a.id);
    v_assets := v_assets + 1;
  end loop;
  -- 2. Every loan: opened, its repayments that landed, then where it ended up.
  for v_l in select * from public.loans order by created_at loop
    perform private.credit_loan_row(v_l.id);
    v_loans := v_loans + 1;
    for v_t in select * from public.transactions
                where kind = 'loan_repay' and source = v_l.id::text and status = 'completed' order by created_at loop
      perform private.credit_loan_repay(v_t);
      v_repays := v_repays + 1;
    end loop;
    if v_l.status <> 'active' and private.credit_loan_status(v_l.status, v_l.closed_by_reset) is not null
       and not exists (select 1 from public.chain_outbox where ref like 'credit:loan_status:' || v_l.id || ':%') then
      perform private.credit_loan_status_row(v_l);
      v_status := v_status + 1;
    end if;
  end loop;
  -- 3. Assets that are no longer active (after the loans, so a released one was free by then).
  for v_a in select * from public.assets where status <> 'active' order by created_at loop
    if not exists (select 1 from public.chain_outbox where ref like 'credit:asset_status:' || v_a.id || ':%') then
      perform private.credit_asset_status_row(v_a);
      v_status := v_status + 1;
    end if;
  end loop;
  return jsonb_build_object('assets', v_assets, 'loans', v_loans, 'repayments', v_repays, 'status_changes', v_status);
end;
$$;
revoke execute on function public.credit_backfill() from public, anon, authenticated;
grant execute on function public.credit_backfill() to service_role;

select public.credit_backfill();
