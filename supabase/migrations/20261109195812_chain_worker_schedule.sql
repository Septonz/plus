-- Running chain-worker and sync-events: every minute from Supabase Cron, and chain-worker also
-- right after each chain_outbox insert (pg_net sends the request after the transaction commits).
-- Unanswered actions expire every 5 minutes (plain SQL, no function call).
--
-- Needs two Vault secrets, created once per project (see README, "Background jobs"):
--   plus_functions_url  e.g. https://<ref>.supabase.co/functions/v1
--   plus_cron_secret    random, generated inside the database; never leaves it except in these calls
-- Without them the jobs do nothing (and say so in the Postgres log).

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Calls an Edge Function with the cron secret. Fire-and-forget.
create or replace function public.invoke_plus_function(p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'plus_functions_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'plus_cron_secret';
  if v_url is null or v_secret is null then
    raise log 'invoke_plus_function(%): vault secrets plus_functions_url / plus_cron_secret not set', p_name;
    return;
  end if;
  perform net.http_post(
    url := v_url || '/' || p_name,
    headers := jsonb_build_object('content-type', 'application/json', 'x-plus-cron-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000);
end;
$$;

-- Lets an Edge Function check the x-plus-cron-secret header without ever reading the secret.
create or replace function public.check_cron_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select decrypted_secret = p_secret and length(p_secret) >= 32
                     from vault.decrypted_secrets where name = 'plus_cron_secret'), false)
$$;

create or replace function public.chain_outbox_kick()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.invoke_plus_function('chain-worker');
  return null;
end;
$$;

create trigger chain_outbox_kick after insert on public.chain_outbox
  for each statement execute function public.chain_outbox_kick();

revoke execute on function public.invoke_plus_function(text) from public, anon, authenticated;
revoke execute on function public.check_cron_secret(text) from public, anon, authenticated;
revoke execute on function public.chain_outbox_kick() from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;

select cron.schedule('plus-chain-worker', '* * * * *', $$ select public.invoke_plus_function('chain-worker') $$);
select cron.schedule('plus-sync-events', '* * * * *', $$ select public.invoke_plus_function('sync-events') $$);
select cron.schedule('plus-expire-actions', '*/5 * * * *', $$ select public.expire_stale_actions() $$);
