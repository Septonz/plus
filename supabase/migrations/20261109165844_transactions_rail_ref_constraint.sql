-- transactions.ref is NOT NULL, so the partial unique index "(rail, ref) where ref is not null"
-- equals a plain unique constraint; the plain form can also be an ON CONFLICT (rail, ref) target.
drop index public.transactions_rail_ref_key;
alter table public.transactions add constraint transactions_rail_ref_key unique (rail, ref);
