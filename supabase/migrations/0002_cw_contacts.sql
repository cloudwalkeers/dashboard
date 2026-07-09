-- cloudwalkeers marketing-site contact / demo-request leads.
create table if not exists public.cw_contacts (
  id         bigint generated always as identity primary key,
  name       text,
  email      text not null,
  message    text,
  source     text,          -- e.g. 'demo', 'pricing'
  created_at timestamptz not null default now()
);
-- service-role backend inserts only (RLS on, no anon/authenticated policy)
alter table public.cw_contacts enable row level security;
