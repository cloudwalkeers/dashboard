// Clipper command center: manage clipper accounts + their per-platform reel
// assignments, and track the views each clip generated. Stored in Supabase
// (clippers + clip_assignments); service-role, server-side only.
// Tenant-scoped: each creator manages their own clipper roster.
import { getDb, isConfigured } from "./supabase.mjs";
import { currentCreatorId } from "../scope.mjs";

export { isConfigured };

/** Assert a clipper belongs to the current creator (no-op outside a request). */
async function assertOwnClipper(db, clipperId) {
  const cid = currentCreatorId();
  if (!cid) return;
  const { data } = await db.from("clippers").select("id").eq("id", clipperId).eq("creator_id", cid).maybeSingle();
  if (!data) throw new Error("clipper not found");
}

/** The creator's clippers with their assignments nested + per-platform totals. */
export async function listClippers() {
  const db = await getDb();
  const cid = currentCreatorId();
  let cq = db.from("clippers").select("*").order("created_at", { ascending: true });
  if (cid) cq = cq.eq("creator_id", cid);
  const { data: clippers, error } = await cq;
  if (error) throw new Error("listClippers: " + error.message);
  let aq = db.from("clip_assignments").select("*").order("created_at", { ascending: false });
  if (cid) aq = aq.in("clipper_id", (clippers || []).map((c) => c.id));
  const { data: assigns, error: e2 } = (clippers || []).length || !cid ? await aq : { data: [], error: null };
  if (e2) throw new Error("listClippers assignments: " + e2.message);
  const byClipper = {};
  for (const a of assigns || []) (byClipper[a.clipper_id] = byClipper[a.clipper_id] || []).push(a);
  return (clippers || []).map((c) => {
    const items = byClipper[c.id] || [];
    const views = items.reduce((s, a) => s + (a.views || 0), 0);
    const likes = items.reduce((s, a) => s + (a.likes || 0), 0);
    const comments = items.reduce((s, a) => s + (a.comments || 0), 0);
    const posted = items.filter((a) => a.status === "posted").length;
    const byPlatform = {};
    for (const a of items) {
      const p = (byPlatform[a.platform] = byPlatform[a.platform] || { assignments: 0, posted: 0, views: 0 });
      p.assignments++; if (a.status === "posted") p.posted++; p.views += a.views || 0;
    }
    return { ...c, assignments: items, totals: { assignments: items.length, posted, views, likes, comments }, byPlatform };
  });
}

export async function createClipper({ name, handle = null, platforms = [], accounts = {} } = {}) {
  const db = await getDb();
  const row = { name: name || "New clipper", handle, platforms, accounts };
  const cid = currentCreatorId();
  if (cid) row.creator_id = cid;
  const { data, error } = await db.from("clippers").insert(row).select().single();
  if (error) throw new Error("createClipper: " + error.message);
  return data;
}

export async function updateClipper(id, patch = {}) {
  const db = await getDb();
  const cid = currentCreatorId();
  const allow = {};
  for (const k of ["name", "handle", "platforms", "accounts", "active", "notes"]) if (k in patch) allow[k] = patch[k];
  let q = db.from("clippers").update(allow).eq("id", id);
  if (cid) q = q.eq("creator_id", cid);
  const { data, error } = await q.select().single();
  if (error) throw new Error("updateClipper: " + error.message);
  return data;
}

export async function deleteClipper(id) {
  const db = await getDb();
  const cid = currentCreatorId();
  let q = db.from("clippers").delete().eq("id", id);
  if (cid) q = q.eq("creator_id", cid);
  const { error } = await q;
  if (error) throw new Error("deleteClipper: " + error.message);
  return { ok: true };
}

/** Create assignment(s): one reel × one or many platforms for a clipper. */
export async function createAssignments({ clipper_id, reel_shortcode, platforms = [], platform = null } = {}) {
  const db = await getDb();
  const plats = platforms.length ? platforms : platform ? [platform] : [];
  if (!clipper_id || !reel_shortcode || !plats.length) throw new Error("createAssignments: clipper_id, reel_shortcode and platform(s) required");
  await assertOwnClipper(db, clipper_id);
  const rows = plats.map((p) => ({ clipper_id, reel_shortcode, platform: p, status: "todo" }));
  const { data, error } = await db.from("clip_assignments").insert(rows).select();
  if (error) throw new Error("createAssignments: " + error.message);
  return data;
}

export async function updateAssignment(id, patch = {}) {
  const db = await getDb();
  const allow = {};
  for (const k of ["status", "posted_url", "posted_at", "views", "likes", "comments", "platform", "notes"]) if (k in patch) allow[k] = patch[k];
  if (patch.status === "posted" && !("posted_at" in patch)) allow.posted_at = new Date().toISOString();
  allow.updated_at = new Date().toISOString();
  const { data: existing } = await db.from("clip_assignments").select("clipper_id").eq("id", id).maybeSingle();
  if (existing) await assertOwnClipper(db, existing.clipper_id);
  const { data, error } = await db.from("clip_assignments").update(allow).eq("id", id).select().single();
  if (error) throw new Error("updateAssignment: " + error.message);
  return data;
}

export async function deleteAssignment(id) {
  const db = await getDb();
  const { data: existing } = await db.from("clip_assignments").select("clipper_id").eq("id", id).maybeSingle();
  if (existing) await assertOwnClipper(db, existing.clipper_id);
  const { error } = await db.from("clip_assignments").delete().eq("id", id);
  if (error) throw new Error("deleteAssignment: " + error.message);
  return { ok: true };
}

/** Auto-fetch public views/likes for every assignment that has a posted URL
 *  (YouTube/TikTok via yt-dlp, token-free) and upsert them. Concurrency-limited. */
export async function refreshAllViews({ concurrency = 4 } = {}) {
  const db = await getDb();
  const { data, error } = await db.from("clip_assignments").select("id, posted_url").not("posted_url", "is", null);
  if (error) throw new Error("refreshAllViews: " + error.message);
  const queue = (data || []).filter((r) => r.posted_url && /^https?:\/\//i.test(r.posted_url));
  const total = queue.length;
  const { reelStats } = await import("../analysis/download.mjs");
  let updated = 0, failed = 0;
  async function worker() {
    while (queue.length) {
      const r = queue.shift();
      try {
        const s = await reelStats(r.posted_url);
        if (s && (s.views != null || s.likes != null)) {
          const patch = { updated_at: new Date().toISOString(), status: "posted" };
          if (s.views != null) patch.views = s.views;
          if (s.likes != null) patch.likes = s.likes;
          if (s.comments != null) patch.comments = s.comments;
          await db.from("clip_assignments").update(patch).eq("id", r.id);
          updated++;
        } else failed++;
      } catch { failed++; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker));
  return { updated, failed, total };
}
