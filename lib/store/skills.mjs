// Per-creator "skills": reusable pasted-markdown instructions the creator wants
// applied to script generation. Each creator owns their own set; the ACTIVE ones get
// injected into both Studio and Create→Script generation. Tenant-scoped.
import { getDb, isConfigured } from "./supabase.mjs";
import { currentCreatorId } from "../scope.mjs";

export { isConfigured };

const COLS = "id,name,content,active,scope,created_at,updated_at";

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
