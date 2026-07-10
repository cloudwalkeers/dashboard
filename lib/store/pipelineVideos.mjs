// Pipeline "Videos" store: reels saved from Discovery (with their outlier/match
// scores + dates) for later content extraction. Per-tenant, mirrors the scripts store.
import { getDb, isConfigured } from "./supabase.mjs";
import { currentCreatorId } from "../scope.mjs";

export { isConfigured };

const COLS =
  "id,shortcode,permalink,source_account,caption,thumbnail_url,media_type,duration_sec,views,like_count,comment_count,outlier,velocity,engagement,match,taken_at,added_at,status,note";

export async function listVideos() {
  const cid = currentCreatorId();
  if (!cid) return [];
  const db = await getDb();
  const { data, error } = await db.from("pipeline_videos").select(COLS)
    .eq("creator_id", cid).order("added_at", { ascending: false });
  if (error) throw new Error("pipeline_videos list: " + error.message);
  return data || [];
}

/** Save a reel to the pipeline (dedup per tenant+shortcode). */
export async function saveVideo(v) {
  const cid = currentCreatorId();
  if (!cid) throw new Error("pipeline_videos: no tenant in scope");
  if (!v || !v.shortcode) throw new Error("shortcode required");
  const db = await getDb();
  const row = {
    creator_id: cid,
    shortcode: v.shortcode,
    permalink: v.permalink || null,
    source_account: (v.source_account || v.creator_username || "").replace(/^@/, "").toLowerCase() || null,
    caption: v.caption || null,
    thumbnail_url: v.thumbnail_url || null,
    media_type: v.media_type || null,
    duration_sec: v.duration_sec ?? null,
    views: v.views ?? null,
    like_count: v.like_count ?? null,
    comment_count: v.comment_count ?? null,
    outlier: v.outlier ?? null,
    velocity: v.velocity ?? null,
    engagement: v.engagement ?? null,
    match: v.match ?? null,
    taken_at: v.taken_at || null,
  };
  const { data, error } = await db.from("pipeline_videos").upsert(row, { onConflict: "creator_id,shortcode" }).select(COLS).single();
  if (error) throw new Error("pipeline_videos save: " + error.message);
  return data;
}

export async function updateVideo(id, patch = {}) {
  const cid = currentCreatorId();
  if (!cid) throw new Error("no tenant in scope");
  const db = await getDb();
  const row = {};
  if (patch.status !== undefined) row.status = patch.status || "saved";
  if (patch.note !== undefined) row.note = patch.note || null;
  const { data, error } = await db.from("pipeline_videos").update(row).eq("id", id).eq("creator_id", cid).select(COLS).single();
  if (error) throw new Error("pipeline_videos update: " + error.message);
  return data;
}

export async function deleteVideo(id) {
  const cid = currentCreatorId();
  if (!cid) throw new Error("no tenant in scope");
  const db = await getDb();
  const { error } = await db.from("pipeline_videos").delete().eq("id", id).eq("creator_id", cid);
  if (error) throw new Error("pipeline_videos delete: " + error.message);
  return { ok: true };
}
