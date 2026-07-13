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

/** Append a raw Studio follow-up prompt to the refinement LOG. Deduped, capped at 25.
 *  NOT injected into prompts — it's the input captureRefinementTurn distills PATTERNS
 *  from; only promoted rules (in the Refinements skill) influence generation. */
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

/** Clear the legacy hidden style notes — called once when they're migrated into the
 *  editable "Refinements" skill, so nothing is injected twice. */
export async function clearStyleNotes() {
  const cid = currentCreatorId();
  if (!cid) return;
  const db = await getDb();
  const r = await row(db, cid);
  const { error } = await db.from("creator_prefs").upsert(
    { creator_id: cid, style_notes: [], mediakit: r.mediakit || {}, updated_at: new Date().toISOString() },
    { onConflict: "creator_id" }
  );
  if (error) throw new Error("clearStyleNotes: " + error.message);
}
