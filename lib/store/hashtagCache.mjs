// Shared hashtag cache + quota bookkeeping for discovery. Hashtag results are
// public/global, so every creator shares one cache: the first search this window
// hits Instagram, everyone after gets it instantly — and Meta's 30-unique-hashtags
// per rolling week budget survives many clients. Service-role only.
import { getDb, isConfigured } from "./supabase.mjs";

export { isConfigured };

const TABLE = "discovery_hashtag_cache";
export const WEEK_MS = 7 * 86400000;
export const QUOTA_LIMIT = 30;   // Meta's cap on unique hashtags per app user / 7 days
export const QUOTA_GUARD = 28;   // leave headroom so we never slam into the hard cap

export async function getCached(tag, type) {
  const db = await getDb();
  const { data } = await db.from(TABLE).select("*").eq("tag", tag).eq("type", type).maybeSingle();
  return data || null;
}

export async function putCached(tag, type, hashtagId, results) {
  const db = await getDb();
  await db.from(TABLE).upsert(
    { tag, type, hashtag_id: hashtagId || null, results: results || [], fetched_at: new Date().toISOString() },
    { onConflict: "tag,type" }
  );
}

/** How much of the rolling-week budget is spent, and whether `tag` is already in
 *  the window (re-querying a hashtag already counted this week is free). */
export async function quotaState(tag) {
  const db = await getDb();
  const since = new Date(Date.now() - WEEK_MS).toISOString();
  const { data } = await db.from(TABLE).select("tag, fetched_at").gt("fetched_at", since);
  const tags = new Set((data || []).map((r) => r.tag));
  return { used: tags.size, limit: QUOTA_LIMIT, guard: QUOTA_GUARD, hasTag: tags.has(tag) };
}
