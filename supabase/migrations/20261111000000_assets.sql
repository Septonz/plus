-- Piece 5: assets, from day one, for any user (Nigeria first).
--   Registered -> Evidence verified (a live photo: stored privately in Storage, only its hash here,
--   with the time and an approximate location) -> Community verified (two eligible witnesses
--   confirm) -> Independently verified (an agent inspects it). Levels only go up.
--   Statuses: active, under_review, lost, stolen, damaged, released. Only active assets count for
--   lending. The confidence score (0-100) is internal, for lenders: never selectable by the app.
-- Nothing here goes on-chain.

alter table public.assets
  add column evidence_hash text check (evidence_hash ~ '^[0-9a-f]{64}$'),
  add column evidence_at timestamptz,
  -- Approximate only: rounded to 2 decimals (about 1 km).
  add column evidence_lat numeric(5, 2) check (evidence_lat between -90 and 90),
  add column evidence_lon numeric(5, 2) check (evidence_lon between -180 and 180),
  add column inspected_value bigint check (inspected_value > 0),                -- kobo
  add column inspected_at timestamptz,
  add column inspected_by uuid references public.helpers (id);
grant select (evidence_at) on public.assets to authenticated;

-- A witness (community) or an inspection (independent). A community witness is a Plus user or an
-- agent she asked; an inspection is open to any active agent in her market until one takes it.
create table public.asset_witnesses (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets (id) on delete cascade,
  kind text not null check (kind in ('community', 'inspection')),
  witness_user_id uuid references public.users (id),
  witness_helper_id uuid references public.helpers (id),
  status text not null default 'requested' check (status in ('requested', 'confirmed', 'declined', 'cancelled')),
  note text check (char_length(note) <= 200),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  check (num_nonnulls(witness_user_id, witness_helper_id) <= 1),
  check (kind = 'inspection' or num_nonnulls(witness_user_id, witness_helper_id) = 1),
  check (kind = 'community' or witness_user_id is null)
);
create unique index asset_witnesses_one_user on public.asset_witnesses (asset_id, witness_user_id)
  where witness_user_id is not null and status in ('requested', 'confirmed');
create unique index asset_witnesses_one_helper on public.asset_witnesses (asset_id, witness_helper_id)
  where kind = 'community' and witness_helper_id is not null and status in ('requested', 'confirmed');
create unique index asset_witnesses_one_open_inspection on public.asset_witnesses (asset_id)
  where kind = 'inspection' and status = 'requested';
create index asset_witnesses_user_idx on public.asset_witnesses (witness_user_id, status);
create index asset_witnesses_helper_idx on public.asset_witnesses (witness_helper_id, status);
alter table public.asset_witnesses enable row level security;
revoke all on public.asset_witnesses from anon, authenticated;

create table public.asset_events (
  id bigint generated always as identity primary key,
  asset_id uuid not null references public.assets (id) on delete cascade,
  kind text not null check (kind in ('registered', 'evidence', 'witness_requested', 'witness_confirmed', 'witness_declined',
                                     'inspection_requested', 'inspected', 'inspection_failed', 'level', 'status')),
  note text check (char_length(note) <= 200),
  created_at timestamptz not null default now()
);
create index asset_events_asset_idx on public.asset_events (asset_id, created_at desc);
alter table public.asset_events enable row level security;
revoke all on public.asset_events from anon, authenticated;

-- Evidence photos: private. No policies, so only the service role (Edge Functions) can read or write.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('asset-evidence', 'asset-evidence', false, 2097152, array['image/jpeg'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Who may witness: verified ID (tier 2), with Plus 6+ weeks, good standing (not frozen, no late
-- or defaulted loan). Agents are eligible by role (checked in the Edge Function).
-- ---------------------------------------------------------------------------
create or replace function public.asset_witness_eligible(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.users u
     where u.id = p_user_id and u.archived_at is null and u.kyc_tier >= 2
       and u.member_since <= now() - interval '6 weeks'
       and (u.borrowing_frozen_until is null or u.borrowing_frozen_until <= now())
       and not exists (select 1 from public.loans l where l.user_id = u.id and l.status in ('late', 'default'))
  );
$$;
revoke execute on function public.asset_witness_eligible(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Level (only ever up) and the internal confidence score, from what is on record.
-- ---------------------------------------------------------------------------
create or replace function public.asset_recompute(p_asset_id uuid)
returns public.assets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.assets;
  v_community integer;
  v_inspected boolean;
  v_derived text;
  v_rank_old integer;
  v_rank_new integer;
  v_conf integer;
begin
  select * into v_a from public.assets where id = p_asset_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  select count(*) filter (where kind = 'community' and status = 'confirmed'),
         bool_or(kind = 'inspection' and status = 'confirmed')
    into v_community, v_inspected
    from public.asset_witnesses where asset_id = p_asset_id;
  v_derived := case
    when v_a.evidence_hash is not null and v_community >= 2 and coalesce(v_inspected, false) then 'independently_verified'
    when v_a.evidence_hash is not null and v_community >= 2 then 'community_verified'
    when v_a.evidence_hash is not null then 'evidence_verified'
    else 'registered' end;
  v_rank_old := array_position(array['registered', 'evidence_verified', 'community_verified', 'independently_verified'], v_a.level);
  v_rank_new := array_position(array['registered', 'evidence_verified', 'community_verified', 'independently_verified'], v_derived);
  if v_rank_new > v_rank_old then
    update public.assets set level = v_derived where id = p_asset_id;
    insert into public.asset_events (asset_id, kind, note) values (p_asset_id, 'level', v_derived);
    v_a.level := v_derived;
  end if;
  v_conf := case v_a.level when 'independently_verified' then 85 when 'community_verified' then 60 when 'evidence_verified' then 35 else 10 end
          + least(10, 5 * greatest(0, v_community - 2))
          + case when v_a.inspected_value is not null and abs(v_a.inspected_value - v_a.estimated_value) * 5 <= v_a.estimated_value then 5 else 0 end
          - case when v_a.evidence_at is not null and v_a.evidence_at < now() - interval '180 days' then 10 else 0 end
          - case when v_a.status = 'under_review' then 20 else 0 end;
  if v_a.status not in ('active', 'under_review') then v_conf := 0; end if;
  update public.assets set confidence = greatest(0, least(100, v_conf)) where id = p_asset_id returning * into v_a;
  return v_a;
end;
$$;
revoke execute on function public.asset_recompute(uuid) from public, anon, authenticated;
