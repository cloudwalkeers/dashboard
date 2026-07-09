-- Last-known follower count per connection (refreshed on every live sync), so
-- stored-path views (media kit, dashboard) can show it without an API round-trip.
alter table public.platform_connections add column if not exists followers bigint;
