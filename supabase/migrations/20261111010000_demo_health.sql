-- Piece 6: pnpm demo:ready asks the database whether the cron jobs are running and whether the
-- Edge Functions they call answer 2xx (2026-11-10: a gateway JWT check gave pg_cron 401s for 45
-- minutes and nothing said so). Service role only; returns no personal data.
create or replace function public.demo_health()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', j.jobname,
        'schedule', j.schedule,
        'active', j.active,
        'last_status', d.status,
        'last_seconds_ago', extract(epoch from now() - d.end_time)::int
      ) order by j.jobname)
      from cron.job j
      left join lateral (
        select status, end_time from cron.job_run_details r where r.jobid = j.jobid order by r.start_time desc limit 1
      ) d on true
      where j.jobname like 'plus-%'
    ), '[]'::jsonb),
    -- Answers to the calls pg_cron made through pg_net in the last 5 minutes.
    'http_ok', (select count(*) from net._http_response where created > now() - interval '5 minutes' and status_code between 200 and 299),
    'http_failed', (select count(*) from net._http_response where created > now() - interval '5 minutes' and (status_code is null or status_code not between 200 and 299)),
    'http_failed_codes', coalesce((
      select jsonb_agg(distinct coalesce(status_code::text, coalesce(error_msg, 'no answer')))
      from net._http_response where created > now() - interval '5 minutes' and (status_code is null or status_code not between 200 and 299)
    ), '[]'::jsonb),
    'outbox_waiting', (select count(*) from public.chain_outbox where status in ('queued', 'submitted')),
    'outbox_oldest_seconds', (select extract(epoch from now() - min(created_at))::int from public.chain_outbox where status in ('queued', 'submitted'))
  );
$$;
revoke execute on function public.demo_health() from public, anon, authenticated;
grant execute on function public.demo_health() to service_role;
