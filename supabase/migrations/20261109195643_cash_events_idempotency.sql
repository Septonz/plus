-- cash_events.idempotency_key: a helper's retried "record cash" call creates one event, not two.
alter table public.cash_events add column idempotency_key text check (idempotency_key <> '');
create unique index cash_events_helper_idem_key on public.cash_events (helper_id, idempotency_key);
