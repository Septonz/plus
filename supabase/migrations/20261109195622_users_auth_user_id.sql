-- users.auth_user_id: links a Plus user to a Supabase Auth login (the app).
-- Demo: seed:db links Selvi to a demo account. Production login is phone OTP plus PIN.
alter table public.users
  add column auth_user_id uuid unique references auth.users (id) on delete set null;
