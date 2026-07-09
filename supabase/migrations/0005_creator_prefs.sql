-- Per-creator preferences: standing style notes (fed into every Studio generation)
-- and media-kit custom fields (tagline, pricing, contact). Service-role only.
create table if not exists public.creator_prefs (
  creator_id  uuid primary key references auth.users(id) on delete cascade,
  style_notes jsonb not null default '[]',
  mediakit    jsonb not null default '{}',
  updated_at  timestamptz not null default now()
);
alter table public.creator_prefs enable row level security;
