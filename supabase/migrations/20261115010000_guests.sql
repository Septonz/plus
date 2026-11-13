-- Piece 12, item 2: public test mode. Anyone with the link taps "Try Plus now" and gets a guest
-- trader of their own, pre-seeded with Funmi's whole story; "Try the agent app" gets a guest agent.
--
--   users.guest_slot / helpers.guest_slot   which pool place a row is (null = not a guest).
--     Traders 1..GUEST_POOL_SIZE; agents: 0 = the shared demo agent behind the guests' pretend
--     cash-ins and pay-outs, 1..3 = the guest agents for "Try the agent app".
--   guest_pool        one row per place: who holds it (a hashed device id), when it was last used,
--                     and where its reset stands. Service role only.
--   guest_starts      new guest sessions per address (hashed), for the per-address limit.
--   guest_assign()    picks a place atomically (see below).
--   groups.payout_once / retired_at   a guest's finished ajo round pays out once and is then
--                     skipped by the scheduler, so old rounds don't pile up.
-- Nothing a guest does can reach the presenter accounts (demo_login): the tools refuse it.

alter table public.users add column if not exists guest_slot integer unique check (guest_slot between 1 and 200);
alter table public.helpers add column if not exists guest_slot integer unique check (guest_slot between 0 and 20);
alter table public.groups add column if not exists payout_once boolean not null default false;
alter table public.groups add column if not exists retired_at timestamptz;

create table public.guest_pool (
  kind text not null check (kind in ('trader', 'agent')),
  slot integer not null,
  user_id uuid unique references public.users (id) on delete set null,
  helper_id uuid unique references public.helpers (id) on delete set null,
  device_hash text,
  assigned_at timestamptz,
  last_seen_at timestamptz,
  -- used since its last reset started: the next idle period resets it
  used boolean not null default false,
  reset_requested_at timestamptz,
  reset_started_at timestamptz,
  reset_done_at timestamptz,
  reset_step text,
  reset_error text,
  history_seeded boolean not null default false,
  -- the ajo round being created on Stellar (group_create's outbox row), until its id is known
  ajo_create_outbox_id bigint,
  primary key (kind, slot),
  check ((kind = 'trader' and user_id is not null) or (kind = 'agent' and helper_id is not null) or (user_id is null and helper_id is null))
);
alter table public.guest_pool enable row level security;  -- service role only
revoke all on public.guest_pool from anon, authenticated;

create table public.guest_starts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  kind text not null,
  at timestamptz not null default now()
);
create index guest_starts_ip_at on public.guest_starts (ip_hash, at desc);
alter table public.guest_starts enable row level security;
revoke all on public.guest_starts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- guest_assign: the place for this device, in one transaction (an advisory lock per kind, so two
-- visitors never get the same place at the same instant).
--   1. This device used a place in the last 2 hours: the same place again (a refresh, or coming back).
--   2. Otherwise (at most p_per_hour new sessions per address an hour): the least recently used
--      place idle for 30 minutes or more, preferring ones no device has held for 2 hours and ones
--      already reset. Nothing idle: the oldest one, flagged busy ("someone else may be testing").
-- Returns { ok, slot, user_id, helper_id, same, busy, needs_reset }. needs_reset: it was used since
-- its last reset and has been idle, so the caller resets it before handing it over.
-- ---------------------------------------------------------------------------
create or replace function public.guest_assign(p_kind text, p_device_hash text, p_ip_hash text, p_per_hour integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.guest_pool;
  v_busy boolean;
  v_reset boolean;
begin
  if p_kind not in ('trader', 'agent') or coalesce(length(p_device_hash), 0) < 16 then
    raise exception 'bad_request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('guest_assign:' || p_kind, 0));

  select * into v from public.guest_pool
   where kind = p_kind and slot > 0 and device_hash = p_device_hash and coalesce(user_id, helper_id) is not null
     and greatest(assigned_at, last_seen_at) > now() - interval '2 hours'
   order by last_seen_at desc nulls last limit 1;
  if found then
    update public.guest_pool set last_seen_at = now() where kind = v.kind and slot = v.slot;
    return jsonb_build_object('ok', true, 'slot', v.slot, 'user_id', v.user_id, 'helper_id', v.helper_id, 'same', true, 'busy', false, 'needs_reset', false);
  end if;

  if (select count(*) from public.guest_starts where ip_hash = p_ip_hash and at > now() - interval '1 hour') >= p_per_hour then
    return jsonb_build_object('ok', false, 'error', 'too_many_sessions');
  end if;

  select * into v from public.guest_pool
   where kind = p_kind and slot > 0 and coalesce(user_id, helper_id) is not null
   order by (coalesce(last_seen_at, 'epoch') < now() - interval '30 minutes') desc,
            (device_hash is null or coalesce(last_seen_at, 'epoch') < now() - interval '2 hours') desc,
            (not used and reset_requested_at is null) desc,
            last_seen_at asc nulls first
   limit 1
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_guests');
  end if;
  v_busy := coalesce(v.last_seen_at, 'epoch') > now() - interval '30 minutes';
  v_reset := v.used and not v_busy;
  insert into public.guest_starts (ip_hash, kind) values (p_ip_hash, p_kind);
  delete from public.guest_starts where at < now() - interval '2 days';
  update public.guest_pool set device_hash = p_device_hash, assigned_at = now(), last_seen_at = now()
   where kind = v.kind and slot = v.slot;
  return jsonb_build_object('ok', true, 'slot', v.slot, 'user_id', v.user_id, 'helper_id', v.helper_id, 'same', false, 'busy', v_busy, 'needs_reset', v_reset);
end;
$$;
revoke all on function public.guest_assign(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.guest_assign(text, text, text, integer) to service_role;

-- A guest did something: last seen now, and used since its last reset. Cheap enough to call on every
-- tool call (it writes at most once a minute per place unless the flag changes).
create or replace function public.guest_touch(p_user_id uuid, p_helper_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.guest_pool set last_seen_at = now(), used = true
   where ((p_user_id is not null and user_id = p_user_id) or (p_helper_id is not null and helper_id = p_helper_id))
     and (not used or last_seen_at is null or last_seen_at < now() - interval '1 minute');
$$;
revoke all on function public.guest_touch(uuid, uuid) from public, anon, authenticated;
grant execute on function public.guest_touch(uuid, uuid) to service_role;

-- The nightly reset of every guest place (03:00 in Lagos), and a per-minute pass that resets places
-- idle for 30 minutes after use and moves running resets along (scheduler/guests).
select cron.schedule('plus-guests-nightly', '0 2 * * *', $$ select public.invoke_plus_function('scheduler/guests-nightly') $$);
select cron.schedule('plus-guests', '* * * * *', $$ select public.invoke_plus_function('scheduler/guests') $$);
