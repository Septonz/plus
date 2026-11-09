-- helpers.auth_user_id: links a helper (e.g. a group leader) to a Supabase Auth login (helper page).
alter table public.helpers
  add column auth_user_id uuid unique references auth.users (id) on delete set null;
