// Guides store: generated guides, editable + publishable. Per-tenant. The public site
// (other project) reads published rows by slug to render each as its own page.
import { getDb, isConfigured } from "./supabase.mjs";
import { currentCreatorId } from "../scope.mjs";

export { isConfigured };

const COLS = "id,slug,title,source_shortcode,source_url,body_md,status,cover_url,created_at,updated_at";

function slugify(s) {
  const base = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return base || "guide";
}

export async function listGuides() {
  const cid = currentCreatorId();
  if (!cid) return [];
  const db = await getDb();
  const { data, error } = await db.from("guides").select(COLS).eq("creator_id", cid).order("updated_at", { ascending: false });
  if (error) throw new Error("guides list: " + error.message);
  return data || [];
}

export async function getGuide(id) {
  const cid = currentCreatorId();
  if (!cid) return null;
  const db = await getDb();
  const { data } = await db.from("guides").select(COLS).eq("id", id).eq("creator_id", cid).maybeSingle();
  return data || null;
}

/** Insert a freshly generated guide, ensuring a unique slug per creator. */
export async function createGuide(g) {
  const cid = currentCreatorId();
  if (!cid) throw new Error("guides: no tenant in scope");
  const db = await getDb();
  const base = slugify(g.title);
  const row = {
    creator_id: cid, title: g.title || "Untitled guide",
    source_shortcode: g.source_shortcode || null, source_url: g.source_url || null,
    body_md: g.body_md || "", cover_url: g.cover_url || null, status: "draft",
  };
  for (let n = 1; n <= 6; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const { data, error } = await db.from("guides").insert({ ...row, slug }).select(COLS).single();
    if (!error) return data;
    if (error.code !== "23505") throw new Error("guides create: " + error.message);
  }
  throw new Error("guides create: couldn't allocate a unique slug");
}

export async function updateGuide(id, patch = {}) {
  const cid = currentCreatorId();
  if (!cid) throw new Error("guides: no tenant in scope");
  const db = await getDb();
  const row = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.body_md !== undefined) row.body_md = patch.body_md;
  if (patch.status !== undefined) row.status = patch.status || "draft";
  const { data, error } = await db.from("guides").update(row).eq("id", id).eq("creator_id", cid).select(COLS).single();
  if (error) throw new Error("guides update: " + error.message);
  return data;
}

export async function deleteGuide(id) {
  const cid = currentCreatorId();
  if (!cid) throw new Error("guides: no tenant in scope");
  const db = await getDb();
  const { error } = await db.from("guides").delete().eq("id", id).eq("creator_id", cid);
  if (error) throw new Error("guides delete: " + error.message);
  return { ok: true };
}
