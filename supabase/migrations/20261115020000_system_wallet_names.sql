-- Piece 12: system wallet names may carry a digit (ajo_m1, guest_agent0), the same shape signer_of()
-- already accepts for secret names (STELLAR_SECRET_<A-Z0-9_>).
alter table public.system_wallets drop constraint system_wallets_signer_check;
alter table public.system_wallets add constraint system_wallets_signer_check check (signer ~ '^[a-z][a-z0-9_]{2,31}$');
