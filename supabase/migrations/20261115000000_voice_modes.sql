-- Piece 12, item 1: voice modes, presenter unlocks and a daily budget of voice sessions.
--
--   VOICE_MODE (Supabase secret): off | presenter (default) | on. In presenter mode voice-session
--   gives a signed ElevenLabs URL only to a device unlocked for presenting (the staff login, or the
--   presenter code VOICE_PRESENTER_CODE). Public testers never start a paid conversation.
--   presenter_unlocks: one row per unlocked device. The device holds a signed 7-day token naming
--   the row; the token itself is never stored or logged. Revoking the row locks the device.
--   presenter_code_attempts: wrong codes, so the code can't be guessed (5 per address per 15
--   minutes, 30 overall).
--   voice_sessions + voice_session_claim: every signed URL handed out, counted per Lagos day;
--   past VOICE_DAILY_SESSION_CAP (40) nobody gets a new one until tomorrow.

create table public.presenter_unlocks (
  id uuid primary key default gen_random_uuid(),
  via text not null check (via in ('staff', 'code')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz
);
alter table public.presenter_unlocks enable row level security;  -- service role only
revoke all on public.presenter_unlocks from anon, authenticated;

create table public.presenter_code_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  ok boolean not null,
  at timestamptz not null default now()
);
create index presenter_code_attempts_at on public.presenter_code_attempts (at desc);
alter table public.presenter_code_attempts enable row level security;
revoke all on public.presenter_code_attempts from anon, authenticated;

create table public.voice_sessions (
  id bigint generated always as identity primary key,
  -- users.id, or "ob:<id>" for a sign-up by voice
  subject text not null,
  presenter_unlock_id uuid references public.presenter_unlocks (id) on delete set null,
  day date not null default (now() at time zone 'Africa/Lagos')::date,
  at timestamptz not null default now()
);
create index voice_sessions_day on public.voice_sessions (day);
alter table public.voice_sessions enable row level security;
revoke all on public.voice_sessions from anon, authenticated;

-- May this address try a presenter code now? Wrong codes: 5 per address per 15 minutes, 30 overall.
create or replace function public.presenter_code_allowed(p_ip_hash text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select count(*) from public.presenter_code_attempts where ip_hash = p_ip_hash and not ok and at > now() - interval '15 minutes') < 5
     and (select count(*) from public.presenter_code_attempts where not ok and at > now() - interval '15 minutes') < 30;
$$;

-- One new voice session, if today's count is under the cap. Atomic: an advisory lock per day keeps
-- two taps at once from both slipping under the cap. Returns { ok, count, cap }.
create or replace function public.voice_session_claim(p_subject text, p_unlock uuid, p_cap integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'Africa/Lagos')::date;
  v_n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('voice_sessions:' || v_day::text, 0));
  select count(*) into v_n from public.voice_sessions where day = v_day;
  if v_n >= p_cap then
    return jsonb_build_object('ok', false, 'count', v_n, 'cap', p_cap);
  end if;
  insert into public.voice_sessions (subject, presenter_unlock_id, day) values (p_subject, p_unlock, v_day);
  if p_unlock is not null then
    update public.presenter_unlocks set last_used_at = now() where id = p_unlock;
  end if;
  return jsonb_build_object('ok', true, 'count', v_n + 1, 'cap', p_cap);
end;
$$;

-- What demo:ready and the status route print: today's sessions and the live presenter unlocks.
create or replace function public.voice_today()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'sessions', (select count(*) from public.voice_sessions where day = (now() at time zone 'Africa/Lagos')::date),
    'unlocks', (select count(*) from public.presenter_unlocks where revoked_at is null and expires_at > now()));
$$;

revoke all on function public.presenter_code_allowed(text) from public, anon, authenticated;
revoke all on function public.voice_session_claim(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.voice_today() from public, anon, authenticated;
grant execute on function public.presenter_code_allowed(text) to service_role;
grant execute on function public.voice_session_claim(text, uuid, integer) to service_role;
grant execute on function public.voice_today() to service_role;
