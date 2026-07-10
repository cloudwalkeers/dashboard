// Watchlist store ("Trending" lane) — PER-TENANT. Each creator (creator_id) curates
// their own set of watched influencers, sweeps only that set, and sees only those
// reels; different niches never bleed into each other. Mirrors discovery_reels'
// tenant scoping. Service-role access (server-side); RLS is on with no public policies.
import { getDb, isConfigured } from "./supabase.mjs";
import { currentCreatorId } from "../scope.mjs";

export { isConfigured };

const CREATOR_COLS =
  "id,creator_id,username,ig_user_id,full_name,follower_count,avatar_url,region,active,added_at,last_swept_at,backfilled_at,median_views,last_error";
const REEL_COLS =
  "id,shortcode,creator_username,ig_user_id,permalink,caption,thumbnail_url,media_type,duration_sec,audio_id,audio_title,audio_artist,is_collab,taken_at,views,like_count,comment_count,captured_at,prev_views,prev_captured_at,outlier,velocity,engagement,first_seen_at,last_seen_at";

// Writes MUST be tenant-scoped; a null creator_id would violate the NOT NULL column
// and (worse) leak across workspaces. Reads with no scope return empty.
function requireCid() {
  const cid = currentCreatorId();
  if (!cid) throw new Error("watchlist: no tenant in scope (run inside a creator scope)");
  return cid;
}

// ── Creators ────────────────────────────────────────────────────────────────

export async function listCreators({ activeOnly = false } = {}) {
  const cid = currentCreatorId();
  if (!cid) return [];
  const db = await getDb();
  let q = db.from("watch_creators").select(CREATOR_COLS).eq("creator_id", cid)
    .order("follower_count", { ascending: false, nullsFirst: false });
  if (activeOnly) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw new Error("watch_creators list: " + error.message);
  return data || [];
}

/** Add or refresh a creator on THIS tenant's watchlist (dedup on creator_id+username). */
export async function addCreator({ username, igUserId = null, fullName = null, followerCount = null, avatar = null, region = null }) {
  const cid = requireCid();
  const db = await getDb();
  const handle = String(username || "").replace(/^@/, "").trim().toLowerCase();
  if (!handle) throw new Error("username required");
  const row = {
    creator_id: cid,
    username: handle,
    ig_user_id: igUserId ? String(igUserId) : null,
    full_name: fullName,
    follower_count: followerCount,
    avatar_url: avatar,
    region: region || null,
    active: true,
  };
  const { data, error } = await db.from("watch_creators").upsert(row, { onConflict: "creator_id,username" }).select(CREATOR_COLS).single();
  if (error) throw new Error("watch_creators add: " + error.message);
  return data;
}

/** Remove a creator AND cascade their reels + snapshots — otherwise the leaderboard
 *  keeps showing content from a creator you already dropped. */
export async function removeCreator(username) {
  const cid = requireCid();
  const db = await getDb();
  const handle = String(username || "").replace(/^@/, "").trim().toLowerCase();
  const { data: reels } = await db.from("watch_reels").select("shortcode").eq("creator_id", cid).eq("creator_username", handle);
  const codes = (reels || []).map((r) => r.shortcode);
  if (codes.length) {
    await db.from("watch_reel_snapshots").delete().eq("creator_id", cid).in("shortcode", codes);
    await db.from("watch_reels").delete().eq("creator_id", cid).eq("creator_username", handle);
  }
  const { error } = await db.from("watch_creators").delete().eq("creator_id", cid).eq("username", handle);
  if (error) throw new Error("watch_creators remove: " + error.message);
  return { ok: true };
}

/** Record the outcome of a sweep for a creator (baseline median + timestamp/error). */
export async function markSwept(username, { medianViews = null, error = null, backfilled = false } = {}) {
  const cid = requireCid();
  const db = await getDb();
  const patch = { last_swept_at: new Date().toISOString(), last_error: error || null };
  if (medianViews != null) patch.median_views = Math.round(medianViews);
  if (backfilled) patch.backfilled_at = new Date().toISOString();
  await db.from("watch_creators").update(patch).eq("creator_id", cid).eq("username", String(username).toLowerCase());
}

/** Stored reels for one watched creator (this tenant) — reused for the outlier
 *  baseline so sweeps don't have to re-scrape history. */
export async function creatorReelViews(username) {
  const cid = currentCreatorId();
  if (!cid) return [];
  const db = await getDb();
  const { data } = await db.from("watch_reels")
    .select("shortcode,views,taken_at")
    .eq("creator_id", cid)
    .eq("creator_username", String(username).toLowerCase());
  return data || [];
}

/** This tenant's best-performing watched creators (by their reels' top outlier), to
 *  seed niche recommendations. Falls back to any creators with a resolved id. */
export async function seedCreators(limit = 4) {
  const cid = currentCreatorId();
  if (!cid) return [];
  const db = await getDb();
  const { data: reels } = await db.from("watch_reels")
    .select("creator_username,ig_user_id,outlier").eq("creator_id", cid).not("ig_user_id", "is", null);
  const byC = new Map();
  for (const r of reels || []) {
    const g = byC.get(r.creator_username) || { username: r.creator_username, ig_user_id: r.ig_user_id, best: 0 };
    g.best = Math.max(g.best, r.outlier || 0);
    if (r.ig_user_id) g.ig_user_id = r.ig_user_id;
    byC.set(r.creator_username, g);
  }
  let seeds = [...byC.values()].sort((a, b) => b.best - a.best);
  if (!seeds.length) {
    // no reels scored yet — fall back to the watchlist creators that have an id
    seeds = (await listCreators()).filter((c) => c.ig_user_id).map((c) => ({ username: c.username, ig_user_id: c.ig_user_id, best: 0 }));
  }
  return seeds.slice(0, limit);
}

/** Distinct tenants that have at least one watched creator — for the background
 *  sweep to iterate and sweep each workspace inside its own scope. Unscoped. */
export async function listTenantsWithWatchlist() {
  const db = await getDb();
  const { data, error } = await db.from("watch_creators").select("creator_id").eq("active", true);
  if (error) throw new Error("watch_creators tenants: " + error.message);
  return [...new Set((data || []).map((r) => r.creator_id).filter(Boolean))];
}

// ── Reels + snapshots ─────────────────────────────────────────────────────────

/** This tenant's existing rows for these shortcodes (to read the prior snapshot and
 *  compute velocity). Keyed by shortcode. */
export async function existingReels(shortcodes) {
  const cid = currentCreatorId();
  if (!cid || !shortcodes || !shortcodes.length) return new Map();
  const db = await getDb();
  const { data, error } = await db
    .from("watch_reels")
    .select("shortcode,views,captured_at,first_seen_at")
    .eq("creator_id", cid)
    .in("shortcode", shortcodes);
  if (error) throw new Error("watch_reels lookup: " + error.message);
  return new Map((data || []).map((r) => [r.shortcode, r]));
}

/** Upsert fully-computed reel rows (metrics derived) + append snapshots, tenant-scoped. */
export async function saveReels(rows) {
  if (!rows || !rows.length) return [];
  const cid = requireCid();
  const db = await getDb();
  const scoped = rows.map((r) => ({ ...r, creator_id: cid }));
  const { data, error } = await db.from("watch_reels").upsert(scoped, { onConflict: "creator_id,shortcode" }).select("shortcode");
  if (error) throw new Error("watch_reels upsert: " + error.message);
  const snaps = scoped.map((r) => ({
    creator_id: cid,
    shortcode: r.shortcode,
    captured_at: r.captured_at,
    views: r.views,
    like_count: r.like_count,
    comment_count: r.comment_count,
  }));
  const { error: sErr } = await db.from("watch_reel_snapshots").insert(snaps);
  if (sErr) throw new Error("watch_reel_snapshots insert: " + sErr.message);
  return data || [];
}

// ── Leaderboard / recommendations ─────────────────────────────────────────────

const SORTS = { velocity: "velocity", outlier: "outlier", engagement: "engagement", views: "views", recent: "taken_at" };

// Duration buckets (seconds): short-form wins are a distinct format from long ones.
const DURATION_BUCKETS = { short: [0, 12], mid: [12, 30], long: [30, 60], xlong: [60, 100000] };

/** Filtered, ranked reels for THIS tenant's Trending feed. All filters optional. */
export async function leaderboard({
  sort = "velocity",
  minOutlier = null, minVelocity = null, minEngagement = null,
  duration = null, sinceDays = null,
  audioId = null, creator = null, region = null,
  collabOnly = false, limit = 60,
} = {}) {
  const cid = currentCreatorId();
  if (!cid) return [];
  const db = await getDb();
  let q = db.from("watch_reels").select(REEL_COLS).eq("creator_id", cid);

  if (minOutlier != null) q = q.gte("outlier", Number(minOutlier));
  if (minVelocity != null) q = q.gte("velocity", Number(minVelocity));
  if (minEngagement != null) q = q.gte("engagement", Number(minEngagement));
  if (audioId) q = q.eq("audio_id", audioId);
  if (creator) q = q.eq("creator_username", String(creator).replace(/^@/, "").toLowerCase());
  if (collabOnly) q = q.eq("is_collab", true);
  if (duration && DURATION_BUCKETS[duration]) {
    const [lo, hi] = DURATION_BUCKETS[duration];
    q = q.gte("duration_sec", lo).lt("duration_sec", hi);
  }
  if (sinceDays) q = q.gte("taken_at", new Date(Date.now() - Number(sinceDays) * 86400000).toISOString());

  const col = SORTS[sort] || SORTS.velocity;
  q = q.order(col, { ascending: false, nullsFirst: false }).limit(Math.min(Number(limit) || 60, 200));

  let { data, error } = await q;
  if (error) throw new Error("watch_reels leaderboard: " + error.message);
  data = data || [];

  // region lives on the watched creator, not the reel — filter in memory (small sets).
  if (region) {
    const creators = await listCreators();
    const inRegion = new Set(creators.filter((c) => (c.region || "").toUpperCase() === region.toUpperCase()).map((c) => c.username));
    data = data.filter((r) => inRegion.has(r.creator_username));
  }
  return data;
}

/** This tenant's reels above an outlier threshold, for trending-audio clustering. */
export async function outlierReels(minOutlier = 1.5) {
  const cid = currentCreatorId();
  if (!cid) return [];
  const db = await getDb();
  const { data, error } = await db
    .from("watch_reels")
    .select("shortcode,creator_username,audio_id,audio_title,audio_artist,outlier,views,permalink,thumbnail_url,taken_at")
    .eq("creator_id", cid)
    .gte("outlier", Number(minOutlier))
    .not("audio_id", "is", null)
    .order("outlier", { ascending: false, nullsFirst: false });
  if (error) throw new Error("watch_reels outliers: " + error.message);
  return data || [];
}

/** This tenant's reels (lightweight) for computing format-bucket aggregates. */
export async function allReelsLite() {
  const cid = currentCreatorId();
  if (!cid) return [];
  const db = await getDb();
  const { data, error } = await db
    .from("watch_reels")
    .select("duration_sec,outlier,engagement,views,velocity")
    .eq("creator_id", cid);
  if (error) throw new Error("watch_reels lite: " + error.message);
  return data || [];
}
