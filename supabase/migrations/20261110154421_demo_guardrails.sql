-- Demo guardrails for the public showcase link.
--   demo_login: the named demo people (Funmi, Kemi, Selvi, Mama Bisi, Meena) whose shared demo
--   password is in the public web bundle. Set by `pnpm demo:logins`; never on staff, partner or
--   admin accounts, nor on real sign-ups.
--   demo_action_log + demo_rate_ok: a per-person limit on money actions, so a stranger with the
--   link can't drain the demo state.

alter table public.users add column if not exists demo_login boolean not null default false;
alter table public.helpers add column if not exists demo_login boolean not null default false;

create table if not exists public.demo_action_log (
  id bigint generated always as identity primary key,
  actor_id uuid not null,       -- users.id or helpers.id
  tool text not null,
  at timestamptz not null default now()
);
create index if not exists demo_action_log_actor_at on public.demo_action_log (actor_id, at desc);
alter table public.demo_action_log enable row level security;  -- service role only

-- Counts the actor's money actions in the last 10 minutes and 24 hours; records this one only if
-- both are under their limits. One call, one transaction (an advisory lock per actor keeps two
-- parallel taps from both slipping under the limit).
create or replace function public.demo_rate_ok(p_actor uuid, p_tool text, p_per_10min int, p_per_day int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n10 int;
  nday int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text, 0));
  select count(*) filter (where at > now() - interval '10 minutes'), count(*)
    into n10, nday
    from demo_action_log
   where actor_id = p_actor and at > now() - interval '24 hours';
  if n10 >= p_per_10min or nday >= p_per_day then
    return false;
  end if;
  insert into demo_action_log (actor_id, tool) values (p_actor, p_tool);
  delete from demo_action_log where at < now() - interval '2 days';
  return true;
end;
$$;

revoke all on function public.demo_rate_ok(uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.demo_rate_ok(uuid, text, int, int) to service_role;
