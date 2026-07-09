-- Shared hashtag-discovery cache. Hashtag results are public/global content, so one
-- platform token serves every creator; this cache makes repeat searches free and
-- protects Meta's 30-unique-hashtags-per-rolling-week budget. Service-role only.
create table if not exists public.discovery_hashtag_cache (
  tag        text not null,
  type       text not null default 'top',   -- 'top' | 'recent'
  hashtag_id text,
  results    jsonb not null default '[]',
  fetched_at timestamptz not null default now(),
  primary key (tag, type)
);
alter table public.discovery_hashtag_cache enable row level security;
