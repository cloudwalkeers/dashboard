-- Discovery dedup becomes per-creator: two creators can save the same reel.
alter table public.discovery_reels drop constraint if exists discovery_reels_shortcode_key;
create unique index if not exists discovery_creator_shortcode_uq
  on public.discovery_reels (creator_id, shortcode);
