-- Piece 11: what she sees in Activity and Home is her life, not our test runs.
--
-- hidden_from_history: the row stays (for audit, balances, the credit picture and Stellar), but the
-- app's lists skip it. Set automatically for the demo reset's own rows (adjustments, settlements),
-- and by `pnpm demo:reset` for everything before its curated recent history.

alter table public.transactions add column if not exists hidden_from_history boolean not null default false;

create or replace function private.transactions_hide_demo_rows()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'adjustment' or coalesce(new.source, '') like 'demo_reset%' or new.source = 'partner_settles_advance' then
    new.hidden_from_history := true;
  end if;
  return new;
end;
$$;
revoke execute on function private.transactions_hide_demo_rows() from public, anon, authenticated;
create trigger transactions_hide_demo_rows before insert on public.transactions
  for each row execute function private.transactions_hide_demo_rows();

update public.transactions set hidden_from_history = true
 where not hidden_from_history
   and (kind = 'adjustment' or coalesce(source, '') like 'demo_reset%' or source = 'partner_settles_advance');

create index if not exists transactions_history on public.transactions (user_id, created_at desc) where not hidden_from_history;
