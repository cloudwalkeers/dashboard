// Discovery library store: inspiration/competitor reels (hashtag API or pasted
// links) with a category + tags, browsable as a source of content ideas.
// Tenant-scoped: each creator has their own board (unique per creator+shortcode).
import { getDb, isConfigured } from "./supabase.mjs";
import { currentCreatorId } from "../scope.mjs";

export { isConfigured };

const COLS =
  "id,created_at,updated_at,shortcode,permalink,ig_account,caption,thumbnail_url,media_type,like_count,comments_count,views,outlier,published_at,source,hashtag,category,tags";

const toTags = (t) =>
  Array.isArray(t) ? t.map((x) => String(x).trim()).filter(Boolean) : String(t || "").split(",").map((x) => x.trim()).filter(Boolean);

/** Upsert discovered reels (dedup per creator + shortcode). */
export async function saveDiscovered(items, { category = null, hashtag = null, source = "link" } = {}) {
  const db = await getDb();
  const now = new Date().toISOString();
  const cid = currentCreatorId();
  const rows = (items || [])
    .filter((it) => it && it.shortcode)
    .map((it) => ({
      creator_id: cid,
      shortcode: it.shortcode,
      permalink: it.permalink || null,
      ig_account: it.account || it.ig_account || null,
      caption: it.caption || null,
      thumbnail_url: it.thumbnail || it.thumbnail_url || null,
      media_type: it.media_type || null,
      like_count: it.likes ?? it.like_count ?? null,
      comments_count: it.comments ?? it.comments_count ?? null,
      views: it.views ?? null,
      outlier: it.outlier ?? null,
      published_at: it.publishedAt || it.timestamp || null,
      source,
      hashtag: hashtag || null,
      category: category || null,
      updated_at: now,
      raw: it.raw || null,
    }));
  if (!rows.length) return [];
  if (cid) {
    const { data, error } = await db.from("discovery_reels").upsert(rows, { onConflict: "creator_id,shortcode" }).select(COLS);
    if (error) throw new Error("discovery upsert: " + error.message);
    return data || [];
  }
  // CLI path (no tenant): dedup manually against existing shortcodes.
  const { data: existing } = await db.from("discovery_reels").select("shortcode").is("creator_id", null);
  const have = new Set((existing || []).map((r) => r.shortcode));
  const fresh = rows.filter((r) => !have.has(r.shortcode));
  if (!fresh.length) return [];
  const { data, error } = await db.from("discovery_reels").insert(fresh).select(COLS);
  if (error) throw new Error("discovery insert: " + error.message);
  return data || [];
}

/** List the creator's library, newest-engagement first, optionally filtered. */
export async function listDiscovery({ category = null, tag = null } = {}) {
  const db = await getDb();
  const cid = currentCreatorId();
  let q = db.from("discovery_reels").select(COLS)
    .order("views", { ascending: false, nullsFirst: false })
    .order("like_count", { ascending: false, nullsFirst: false });
  if (cid) q = q.eq("creator_id", cid);
  if (category) q = q.eq("category", category);
  if (tag) q = q.contains("tags", [tag]);
  const { data, error } = await q;
  if (error) throw new Error("discovery list: " + error.message);
  return data || [];
}

export async function updateDiscovery(id, patch = {}) {
  const db = await getDb();
  const cid = currentCreatorId();
  const row = { updated_at: new Date().toISOString() };
  if (patch.category !== undefined) row.category = patch.category || null;
  if (patch.tags !== undefined) row.tags = toTags(patch.tags);
  let q = db.from("discovery_reels").update(row).eq("id", id);
  if (cid) q = q.eq("creator_id", cid);
  const { data, error } = await q.select(COLS).single();
  if (error) throw new Error("discovery update: " + error.message);
  return data;
}

export async function deleteDiscovery(id) {
  const db = await getDb();
  const cid = currentCreatorId();
  let q = db.from("discovery_reels").delete().eq("id", id);
  if (cid) q = q.eq("creator_id", cid);
  const { error } = await q;
  if (error) throw new Error("discovery delete: " + error.message);
  return { ok: true };
}

/** Distinct non-null categories (this creator's), for the filter chips. */
export async function categories() {
  const db = await getDb();
  const cid = currentCreatorId();
  let q = db.from("discovery_reels").select("category");
  if (cid) q = q.eq("creator_id", cid);
  const { data } = await q;
  return [...new Set((data || []).map((r) => r.category).filter(Boolean))].sort();
}
