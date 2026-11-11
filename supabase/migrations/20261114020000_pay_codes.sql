-- Piece 11: pay a shop. Every Plus Nigeria user can have a short pay code (6 characters, no 0/O,
-- 1/I/L) shown with a QR of a Plus pay link (plus-wallet.vercel.app/app/pay/<code>), never a raw
-- Stellar address. Paying by code is the same prepare_pay -> confirm flow as paying a Plus user.
-- The code is not a secret: it only lets people pay her.

alter table public.users add column if not exists pay_code text
  check (pay_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$');
create unique index if not exists users_pay_code on public.users (pay_code) where pay_code is not null;
