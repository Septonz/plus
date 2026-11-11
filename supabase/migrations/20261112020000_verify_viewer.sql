-- Piece 9 fix: rate-limit /verify by the address Cloudflare saw (cf-connecting-ip), not the first
-- x-forwarded-for entry, which the client controls (checked on the dev project: a spoofed
-- "x-forwarded-for: 1.2.3.4" arrives as "1.2.3.4,<real address>").
create or replace function public.verify_record(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_ip text;
  v_viewer text;
  v_s public.record_shares;
  v_u public.users;
  v_err text;
begin
  -- The viewer's address as Cloudflare saw it (cf-connecting-ip): the client can't set it. The
  -- first x-forwarded-for entry is whatever the client sent, so it is never used.
  begin
    v_ip := coalesce(nullif(current_setting('request.headers', true)::json ->> 'cf-connecting-ip', ''),
                     nullif(current_setting('request.headers', true)::json ->> 'sb-forwarded-for', ''), '');
  exception when others then
    v_ip := '';
  end;
  v_viewer := private.credit_ref('viewer:' || coalesce(nullif(trim(v_ip), ''), 'unknown'));

  if (select count(*) from public.record_verify_attempts where viewer_hash = v_viewer and not ok and at > now() - interval '10 minutes') >= 10
     or (select count(*) from public.record_verify_attempts where not ok and at > now() - interval '10 minutes') >= 300 then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  end if;

  if v_code ~ '^[A-HJKMNP-Z2-9]{8}$' then
    select * into v_s from public.record_shares where code_hash = private.credit_ref('share:' || v_code) for update;
  end if;
  v_err := case
    when v_s.id is null then 'not_found'
    when v_s.revoked_at is not null then 'revoked'
    when v_s.expires_at <= now() then 'expired'
    when v_s.viewer_hash is not null and (v_s.viewer_hash <> v_viewer or v_s.first_viewed_at < now() - interval '1 hour') then 'already_used'
  end;
  insert into public.record_verify_attempts (share_id, viewer_hash, ok, error) values (v_s.id, v_viewer, v_err is null, v_err);
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;

  update public.record_shares
     set views = views + 1, last_viewed_at = now(),
         first_viewed_at = coalesce(first_viewed_at, now()), viewer_hash = coalesce(viewer_hash, v_viewer)
   where id = v_s.id
  returning * into v_s;
  select * into v_u from public.users where id = v_s.user_id;
  return jsonb_build_object(
    'ok', true,
    'borrower_ref', private.credit_ref('user:' || v_s.user_id::text),
    'wallet', v_u.stellar_pub,
    'market', v_u.market_id,
    'shared_at', v_s.created_at,
    'expires_at', v_s.expires_at);
end;
$$;
revoke execute on function public.verify_record(text) from public;
grant execute on function public.verify_record(text) to anon, authenticated, service_role;
