-- cloudwalkeers · multi-tenant foundation (additive, non-breaking).
-- The dashboard backend uses the service-role key, which BYPASSES RLS, so the
-- existing tool keeps working unchanged. RLS here only governs browser/anon access.

-- ── 1. creator profiles (1:1 with auth.users) ───────────────────────────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles
  for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- auto-create a profile row when a creator signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── 2. per-creator platform connections (IG / TikTok / YouTube) ──────────────
-- Tokens live here and are BACKEND-ONLY: RLS is enabled with no anon/authenticated
-- policy, so only the service-role key can read/write. The browser learns its
-- connection status through the server API, never the raw token.
create table if not exists public.platform_connections (
  id               uuid primary key default gen_random_uuid(),
  creator_id       uuid not null references auth.users(id) on delete cascade,
  platform         text not null check (platform in ('instagram','tiktok','youtube')),
  external_id      text,          -- platform account id (e.g. IG user id)
  username         text,
  account_type     text,
  access_token     text,
  refresh_token    text,
  token_expires_at timestamptz,
  scopes           text,
  status           text not null default 'connected',
  connected_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (creator_id, platform)
);
alter table public.platform_connections enable row level security;
-- (intentionally no anon/authenticated policy — service-role backend only)

-- ── 3. tenant key on creator-owned content tables ───────────────────────────
-- Nullable: existing rows belong to the founder account and get backfilled once
-- that account has a login (see 0002).
alter table public.reels            add column if not exists creator_id uuid references auth.users(id) on delete cascade;
alter table public.reel_features    add column if not exists creator_id uuid references auth.users(id) on delete cascade;
alter table public.hypotheses       add column if not exists creator_id uuid references auth.users(id) on delete cascade;
alter table public.pipeline_scripts add column if not exists creator_id uuid references auth.users(id) on delete cascade;
alter table public.discovery_reels  add column if not exists creator_id uuid references auth.users(id) on delete cascade;
alter table public.clippers         add column if not exists creator_id uuid references auth.users(id) on delete cascade;

create index if not exists reels_creator_idx      on public.reels(creator_id);
create index if not exists reel_features_creator_idx on public.reel_features(creator_id);
create index if not exists hypotheses_creator_idx  on public.hypotheses(creator_id);
create index if not exists pipeline_creator_idx    on public.pipeline_scripts(creator_id);
create index if not exists discovery_creator_idx   on public.discovery_reels(creator_id);
create index if not exists clippers_creator_idx    on public.clippers(creator_id);

-- ── 4. SECURITY FIX ─────────────────────────────────────────────────────────
-- These four tables shipped with RLS disabled, i.e. fully readable/writable by
-- anyone holding the public anon key. Enable RLS so only the service-role backend
-- (which bypasses RLS) can touch them. Per-creator authenticated policies are
-- added in 0003 once client-side access is wired.
alter table public.reel_features    enable row level security;
alter table public.hypotheses       enable row level security;
alter table public.pipeline_scripts enable row level security;
alter table public.discovery_reels  enable row level security;
