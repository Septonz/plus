-- tool_calls: audit log of every voice-agent tool call. Never store PINs.
create table public.tool_calls (
  id bigint generated always as identity primary key,
  tool text not null,
  user_id uuid references public.users (id) on delete set null,
  args jsonb not null default '{}'::jsonb,
  result jsonb,
  latency_ms integer check (latency_ms >= 0),
  request_id text,
  created_at timestamptz not null default now(),
  constraint tool_calls_no_pin check (not (args ? 'pin'))
);

create index tool_calls_user_created_idx on public.tool_calls (user_id, created_at desc);
create index tool_calls_tool_created_idx on public.tool_calls (tool, created_at desc);

alter table public.tool_calls enable row level security;
