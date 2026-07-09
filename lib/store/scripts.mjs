// Reels Pipeline store: saved Content-Creation outputs (scripts + visual prompts)
// in the `pipeline_scripts` table. Retrieved/edited from the "Reels Pipeline" tab.
// Rows are tenant-scoped: inside a web request every read/write is filtered to the
// logged-in creator; CLI runs (no scope) behave as before.
import { getDb, isConfigured } from "./supabase.mjs";
import { currentCreatorId } from "../scope.mjs";

export { isConfigured };

const COLS = "id, created_at, updated_at, source_shortcode, account, title, brief, script, transcript, visuals, tags";

function rowFrom(item) {
  return {
    source_shortcode: item.sourceShortcode || item.source_shortcode || null,
    account: item.account || null,
    title: (item.title && String(item.title).trim()) || (item.sourceShortcode ? "Script · " + item.sourceShortcode : "Untitled script"),
    brief: item.brief || null,
    script: item.script || "",
    transcript: item.transcript || null,
    visuals: Array.isArray(item.visuals) ? item.visuals : [],
    tags: Array.isArray(item.tags) ? item.tags.map((t) => String(t).trim()).filter(Boolean) : [],
  };
}

/** Insert a new saved script, or update an existing one when `item.id` is set. */
export async function saveScript(item) {
  const db = await getDb();
  const cid = currentCreatorId();
  const row = rowFrom(item);
  if (item.id) {
    row.updated_at = new Date().toISOString();
    let q = db.from("pipeline_scripts").update(row).eq("id", item.id);
    if (cid) q = q.eq("creator_id", cid);
    const { data, error } = await q.select(COLS).single();
    if (error) throw new Error("script update: " + error.message);
    return data;
  }
  if (cid) row.creator_id = cid;
  const { data, error } = await db.from("pipeline_scripts").insert(row).select(COLS).single();
  if (error) throw new Error("script insert: " + error.message);
  return data;
}

/** The creator's saved scripts, newest-edited first. */
export async function listScripts() {
  const db = await getDb();
  const cid = currentCreatorId();
  let q = db.from("pipeline_scripts").select(COLS).order("updated_at", { ascending: false });
  if (cid) q = q.eq("creator_id", cid);
  const { data, error } = await q;
  if (error) throw new Error("script list: " + error.message);
  return data || [];
}

export async function deleteScript(id) {
  const db = await getDb();
  const cid = currentCreatorId();
  let q = db.from("pipeline_scripts").delete().eq("id", id);
  if (cid) q = q.eq("creator_id", cid);
  const { error } = await q;
  if (error) throw new Error("script delete: " + error.message);
  return { ok: true };
}
