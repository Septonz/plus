-- chain_signers: one lease per signing account, so only one worker submits for it at a time
-- (one transaction at a time per account keeps sequence numbers in order).
create table public.chain_signers (
  signer text primary key,
  holder uuid,
  locked_until timestamptz not null default '-infinity',
  updated_at timestamptz not null default now()
);

alter table public.chain_signers enable row level security;
revoke all on public.chain_signers from anon, authenticated;

create or replace function public.chain_lease(p_signer text, p_holder uuid, p_secs integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.chain_signers as s (signer, holder, locked_until, updated_at)
  values (p_signer, p_holder, now() + make_interval(secs => p_secs), now())
  on conflict (signer) do update
    set holder = excluded.holder, locked_until = excluded.locked_until, updated_at = now()
    where s.locked_until < now() or s.holder = p_holder;
  return found;
end;
$$;

create or replace function public.chain_release(p_signer text, p_holder uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.chain_signers set locked_until = '-infinity', holder = null, updated_at = now()
   where signer = p_signer and holder = p_holder;
$$;

revoke execute on function public.chain_lease(text, uuid, integer) from public, anon, authenticated;
revoke execute on function public.chain_release(text, uuid) from public, anon, authenticated;
grant execute on function public.chain_lease(text, uuid, integer) to service_role;
grant execute on function public.chain_release(text, uuid) to service_role;
