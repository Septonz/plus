-- chain_outbox for money that moves on Stellar (Nigeria) as well as records (India).
--   * More kinds. Classic operations go through Horizon, contract calls through RPC:
--       attest, group_record, contract            -> RPC (Soroban)
--       payment, claimable_create, claimable_claim -> Horizon (classic)
--   * One queue per signing account (signer = the account's name, e.g. partner, funmi, agent_ng).
--     Queues run in parallel; within an account, still one transaction at a time.
--   * after_id: a row waits until another row (possibly on another account's queue) is done,
--     e.g. an advance auto-repayment only after the agent's cash-in payment landed.
--   * result: what the transaction produced (e.g. a claimable balance id).
alter table public.chain_outbox drop constraint chain_outbox_kind_check;
alter table public.chain_outbox add constraint chain_outbox_kind_check
  check (kind in ('attest', 'group_record', 'contract', 'payment', 'claimable_create', 'claimable_claim'));

alter table public.chain_outbox
  add column after_id bigint references public.chain_outbox (id),
  add column result jsonb,
  add constraint chain_outbox_signer_check check (signer ~ '^[a-z][a-z0-9_]{0,31}$');

create index chain_outbox_after_idx on public.chain_outbox (after_id) where after_id is not null;

-- Enqueue on a given signer's queue, optionally after another row. Returns the row id
-- (the existing one when this ref was already enqueued: one row per money movement).
create or replace function public.chain_enqueue_on(p_signer text, p_kind text, p_ref text, p_args jsonb, p_after bigint default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.chain_outbox (signer, kind, ref, args, after_id)
  values (p_signer, p_kind, p_ref, p_args, p_after)
  on conflict (ref) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.chain_outbox where ref = p_ref;
  end if;
  return v_id;
end;
$$;

revoke execute on function public.chain_enqueue_on(text, text, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.chain_enqueue_on(text, text, text, jsonb, bigint) to service_role;
