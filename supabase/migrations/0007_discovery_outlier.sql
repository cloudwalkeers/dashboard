-- Outlier score per discovered reel: views ÷ median views of its search batch.
alter table public.discovery_reels add column if not exists outlier numeric;
