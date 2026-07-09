// Per-creator preferences (creator_prefs): standing Studio style notes and
// media-kit custom fields. Tenant-scoped via the request scope; service-role only.
import { getDb, isConfigured } from "./supabase.mjs";
import { currentCreatorId } from "../scope.mjs";

export { isConfigured };

async function row(db, cid) {
  const { data } = await db.from("creator_prefs").select("*").eq("creator_id", cid).maybeSingle();
  return data || { creator_id: cid, style_notes: [], mediakit: {} };
}

/** Full prefs for the logged-in creator. */
export async function getPrefs() {
  const cid = currentCreatorId();
  if (!cid) return { style_notes: [], mediakit: {} };
  const db = await getDb();
  const r = await row(db, cid);
  return { style_notes: r.style_notes || [], mediakit: r.mediakit || {} };
}

/** Merge-update the media-kit custom fields (tagline, pricing rows, contact…). */
export async function saveMediakit(patch) {
  const cid = currentCreatorId();
  if (!cid) throw new Error("no creator in scope");
  const db = await getDb();
  const r = await row(db, cid);
  const mediakit = { ...(r.mediakit || {}), ...(patch || {}) };
  const { error } = await db.from("creator_prefs").upsert(
    { creator_id: cid, style_notes: r.style_notes || [], mediakit, updated_at: new Date().toISOString() },
    { onConflict: "creator_id" }
  );
  if (error) throw new Error("saveMediakit: " + error.message);
  return mediakit;
}

/** Append a standing style note (from a Studio refinement). Deduped, capped at 25 —
 *  these are injected into every future generation so refinements stick. */
export async function addStyleNote(note) {
  const cid = currentCreatorId();
  const text = String(note || "").trim().slice(0, 300);
  if (!cid || text.length < 4) return;
  const db = await getDb();
  const r = await row(db, cid);
  const notes = (r.style_notes || []).filter((n) => n && n.toLowerCase() !== text.toLowerCase());
  notes.push(text);
  while (notes.length > 25) notes.shift();
  const { error } = await db.from("creator_prefs").upsert(
    { creator_id: cid, style_notes: notes, mediakit: r.mediakit || {}, updated_at: new Date().toISOString() },
    { onConflict: "creator_id" }
  );
  if (error) throw new Error("addStyleNote: " + error.message);
}

/** The standing notes, for prompt injection. */
export async function getStyleNotes() {
  const p = await getPrefs();
  return p.style_notes || [];
}
