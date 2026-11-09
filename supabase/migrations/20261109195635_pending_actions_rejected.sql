-- pending_actions: add 'rejected' (the user said No) and publish changes to Realtime, so the
-- app's confirm screen opens by itself when the voice agent prepares an action.
alter table public.pending_actions drop constraint pending_actions_status_check;
alter table public.pending_actions add constraint pending_actions_status_check
  check (status in ('pending', 'executing', 'done', 'failed', 'expired', 'rejected'));
create index pending_actions_expiry_idx on public.pending_actions (expires_at) where status = 'pending';
alter publication supabase_realtime add table public.pending_actions;
