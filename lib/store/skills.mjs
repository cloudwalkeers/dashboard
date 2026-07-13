// Per-creator "skills": reusable pasted-markdown instructions the creator wants
// applied to script generation. Each creator owns their own set; the ACTIVE ones get
// injected into both Studio and Create→Script generation. Tenant-scoped.
import { getDb, isConfigured } from "./supabase.mjs";
import { currentCreatorId } from "../scope.mjs";

export { isConfigured };

const COLS = "id,name,content,active,scope,created_at,updated_at";

/** Prepended to the injected skills so the model treats them as hard overrides — above
 *  the built-in voice/language/format defaults — and acts on terse shorthand too. */
export const SKILLS_OVERRIDE_HEADER =
  "════════ CREATOR SKILLS — ABSOLUTE OVERRIDE ════════\n" +
  "The following are DIRECT INSTRUCTIONS from the creator and take PRIORITY OVER EVERYTHING above, including the language, voice and format defaults. If a skill conflicts with anything above, the SKILL WINS. Treat each skill as a command and follow it literally and completely — even terse shorthand: infer the obvious intent (e.g. a skill that says only 'make in chinese' means write the ENTIRE script in Chinese; a skill naming a phrase means include that phrase verbatim).";

export async function listSkills({ scope = null } = {}) {
  const cid = currentCreatorId();
  if (!cid) return [];
  const db = await getDb();
  let q = db.from("creator_skills").select(COLS).eq("creator_id", cid);
  if (scope) q = q.eq("scope", scope);
  const { data, error } = await q.order("updated_at", { ascending: false });
  if (error) throw new Error("creator_skills list: " + error.message);
  return data || [];
}

// NOTE: no defaults on name/content/active/scope — they must stay `undefined` when a
// caller omits them, so a partial update (e.g. a toggle sending only {active}) patches
// ONLY that field. Defaulting content to "" here would wipe content on every toggle.
export async function saveSkill({ id = null, name, content, active, scope } = {}) {
  const cid = currentCreatorId();
  if (!cid) throw new Error("creator_skills: no tenant in scope");
  const db = await getDb();
  const now = new Date().toISOString();
  if (id) {
    const patch = { updated_at: now };
    if (name !== undefined) patch.name = name;
    if (content !== undefined) patch.content = content;
    if (active !== undefined) patch.active = !!active;
    if (scope !== undefined && scope) patch.scope = scope;
    const { data, error } = await db.from("creator_skills").update(patch).eq("id", id).eq("creator_id", cid).select(COLS).single();
    if (error) throw new Error("creator_skills update: " + error.message);
    return data;
  }
  const { data, error } = await db.from("creator_skills")
    .insert({ creator_id: cid, name: name || "Untitled skill", content: content || "", active: active !== false, scope: scope || "script" })
    .select(COLS).single();
  if (error) throw new Error("creator_skills insert: " + error.message);
  return data;
}

export async function deleteSkill(id) {
  const cid = currentCreatorId();
  if (!cid) throw new Error("creator_skills: no tenant in scope");
  const db = await getDb();
  const { error } = await db.from("creator_skills").delete().eq("id", id).eq("creator_id", cid);
  if (error) throw new Error("creator_skills delete: " + error.message);
  return { ok: true };
}

/** Concatenated ACTIVE skills for the current tenant, formatted for prompt injection.
 *  Returns "" when there are none — callers append it conditionally. */
export async function activeSkillsText(scope = "script") {
  const cid = currentCreatorId();
  if (!cid) return "";
  const db = await getDb();
  const { data } = await db.from("creator_skills").select("name,content")
    .eq("creator_id", cid).eq("active", true).in("scope", [scope, "both"]).order("updated_at", { ascending: true });
  const skills = (data || []).filter((s) => (s.content || "").trim());
  if (!skills.length) return "";
  return skills.map((s) => `## SKILL — ${s.name}\n${s.content.trim()}`).join("\n\n");
}

const REFINEMENTS_SKILL = "Refinements";

/** Append a refinement note to the creator's auto-managed "Refinements" skill — created
 *  on the FIRST refinement (seeded with any legacy hidden style notes, which are then
 *  cleared so nothing is injected twice). Afterwards it's a normal skill the creator can
 *  edit, toggle on/off, or delete. Returns the skill row (or null if nothing to add). */
export async function appendRefinement(note) {
  const cid = currentCreatorId();
  const text = String(note || "").trim().replace(/\s+/g, " ").slice(0, 300);
  if (!cid || text.length < 4) return null;
  const db = await getDb();
  const line = "- " + text;
  const { data: rows } = await db.from("creator_skills").select(COLS)
    .eq("creator_id", cid).eq("name", REFINEMENTS_SKILL).order("updated_at", { ascending: false }).limit(1);
  const existing = rows && rows[0];
  if (existing) {
    const lines = String(existing.content || "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.some((l) => l.toLowerCase() === line.toLowerCase())) return existing; // already captured
    lines.push(line);
    while (lines.length > 40) lines.shift();
    const { data, error } = await db.from("creator_skills")
      .update({ content: lines.join("\n"), updated_at: new Date().toISOString() })
      .eq("id", existing.id).eq("creator_id", cid).select(COLS).single();
    if (error) throw new Error("appendRefinement update: " + error.message);
    return data;
  }
  // First refinement — create the skill, migrating any legacy hidden style notes into it.
  let seed = [];
  try {
    const prefs = await import("./prefs.mjs");
    const old = await prefs.getStyleNotes();
    seed = (old || []).map((n) => "- " + String(n).trim()).filter((l) => l.length > 3);
    if (seed.length) await prefs.clearStyleNotes();
  } catch { /* prefs optional */ }
  if (!seed.some((l) => l.toLowerCase() === line.toLowerCase())) seed.push(line);
  const { data, error } = await db.from("creator_skills")
    .insert({ creator_id: cid, name: REFINEMENTS_SKILL, content: seed.join("\n"), active: true, scope: "script" })
    .select(COLS).single();
  if (error) throw new Error("appendRefinement insert: " + error.message);
  return data;
}
