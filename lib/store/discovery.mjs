// Discovery library store: inspiration/competitor reels (hashtag API or pasted
// links) with a category + tags, browsable as a source of content ideas.
import { getDb, isConfigured } from "./supabase.mjs";

export { isConfigured };

const COLS =
  "id,created_at,updated_at,shortcode,permalink,ig_account,caption,thumbnail_url,media_type,like_count,comments_count,views,published_at,source,hashtag,category,tags";

const toTags = (t) =>
  Array.isArray(t) ? t.map((x) => String(x).trim()).filter(Boolean) : String(t || "").split(",").map((x) => x.trim()).filter(Boolean);

/** Upsert discovered reels (dedup by shortcode). */
export async function saveDiscovered(items, { category = null, hashtag = null, source = "link" } = {}) {
  const db = await getDb();
  const now = new Date().toISOString();
  const rows = (items || [])
    .filter((it) => it && it.shortcode)
    .map((it) => ({
      shortcode: it.shortcode,
      permalink: it.permalink || null,
      ig_account: it.account || it.ig_account || null,
      caption: it.caption || null,
      thumbnail_url: it.thumbnail || it.thumbnail_url || null,
      media_type: it.media_type || null,
      like_count: it.likes ?? it.like_count ?? null,
      comments_count: it.comments ?? it.comments_count ?? null,
      views: it.views ?? null,
      published_at: it.publishedAt || it.timestamp || null,
      source,
      hashtag: hashtag || null,
      category: category || null,
      updated_at: now,
      raw: it.raw || null,
    }));
  if (!rows.length) return [];
  const { data, error } = await db.from("discovery_reels").upsert(rows, { onConflict: "shortcode" }).select(COLS);
  if (error) throw new Error("discovery upsert: " + error.message);
  return data || [];
}

/** List the library, newest-engagement first, optionally filtered. */
export async function listDiscovery({ category = null, tag = null } = {}) {
  const db = await getDb();
  let q = db.from("discovery_reels").select(COLS)
    .order("views", { ascending: false, nullsFirst: false })
    .order("like_count", { ascending: false, nullsFirst: false });
  if (category) q = q.eq("category", category);
  if (tag) q = q.contains("tags", [tag]);
  const { data, error } = await q;
  if (error) throw new Error("discovery list: " + error.message);
  return data || [];
}

export async function updateDiscovery(id, patch = {}) {
  const db = await getDb();
  const row = { updated_at: new Date().toISOString() };
  if (patch.category !== undefined) row.category = patch.category || null;
  if (patch.tags !== undefined) row.tags = toTags(patch.tags);
  const { data, error } = await db.from("discovery_reels").update(row).eq("id", id).select(COLS).single();
  if (error) throw new Error("discovery update: " + error.message);
  return data;
}

export async function deleteDiscovery(id) {
  const db = await getDb();
  const { error } = await db.from("discovery_reels").delete().eq("id", id);
  if (error) throw new Error("discovery delete: " + error.message);
  return { ok: true };
}

/** Distinct non-null categories, for the filter chips. */
export async function categories() {
  const db = await getDb();
  const { data } = await db.from("discovery_reels").select("category");
  return [...new Set((data || []).map((r) => r.category).filter(Boolean))].sort();
}
