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
    // Wipe-proof: an update may CHANGE name/content but never blank them — an empty
    // string on update is treated as "not provided" (frontends send '' for untouched
    // fields more easily than undefined, and a blanked skill is never intentional:
    // deleting the skill is the intentional path).
    if (name !== undefined && String(name).trim() !== "") patch.name = name;
    if (content !== undefined && String(content).trim() !== "") patch.content = content;
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
const LAB_MARKER = "── LAB LEARNINGS (auto-updated from your reels) ──";

/** Split the Refinements skill's content into the creator's own notes (above the
 *  marker) and the auto-managed lab section (marker to end). */
function splitRefinements(content) {
  const s = String(content || "");
  const i = s.indexOf(LAB_MARKER);
  return i < 0 ? { user: s.trim(), lab: "" } : { user: s.slice(0, i).trim(), lab: s.slice(i).trim() };
}

// Last lab-sync per creator (in-process throttle) — findings only shift when new
// reels/extractions land, so refreshing every 10 min is plenty.
const _labSync = new Map();

/** Refresh the "Lab learnings" section inside the Refinements skill from the Lab
 *  models (hook patterns, retention drivers, save/engagement levers). The creator's
 *  own refinement notes above the marker are never touched; the section below it is
 *  replaced wholesale. Creates the skill if lab findings exist and it doesn't yet.
 *  Best-effort and throttled — call it fire-and-forget before generation. */
export async function syncLabRefinements({ force = false } = {}) {
  const cid = currentCreatorId();
  if (!cid) return;
  const last = _labSync.get(cid) || 0;
  if (!force && Date.now() - last < 10 * 60 * 1000) return;
  _labSync.set(cid, Date.now());
  let lines = [];
  try { lines = await (await import("../studio.mjs")).labFindings(); } catch { return; }
  if (!lines || !lines.length) return;
  const labBlock = LAB_MARKER + "\nApply these measured findings from the creator's own reels where natural (hook, pacing, visuals):\n" + lines.map((l) => "- " + l).join("\n");
  const db = await getDb();
  const { data: rows } = await db.from("creator_skills").select(COLS)
    .eq("creator_id", cid).eq("name", REFINEMENTS_SKILL).order("updated_at", { ascending: false }).limit(1);
  const existing = rows && rows[0];
  if (existing) {
    const { user } = splitRefinements(existing.content);
    const next = (user ? user + "\n\n" : "") + labBlock;
    if (next === existing.content) return;
    await db.from("creator_skills").update({ content: next, updated_at: new Date().toISOString() })
      .eq("id", existing.id).eq("creator_id", cid);
  } else {
    await db.from("creator_skills").insert({ creator_id: cid, name: REFINEMENTS_SKILL, content: labBlock, active: true, scope: "script" });
  }
}

/** Append a PROMOTED rule to the creator's auto-managed "Refinements" skill (created on
 *  first use). Raw follow-up prompts do NOT land here directly — captureRefinementTurn
 *  (lib/studio.mjs) logs them and only promotes a distilled rule when a PATTERN emerges.
 *  A normal skill afterwards: the creator can edit, toggle on/off, or delete it. */
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
    // The creator's notes live ABOVE the lab marker; the auto lab section stays at the end.
    const { user, lab } = splitRefinements(existing.content);
    const lines = user.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.some((l) => l.toLowerCase() === line.toLowerCase())) return existing; // already captured
    lines.push(line);
    while (lines.length > 40) lines.shift();
    const next = lines.join("\n") + (lab ? "\n\n" + lab : "");
    const { data, error } = await db.from("creator_skills")
      .update({ content: next, updated_at: new Date().toISOString() })
      .eq("id", existing.id).eq("creator_id", cid).select(COLS).single();
    if (error) throw new Error("appendRefinement update: " + error.message);
    return data;
  }
  // First promoted rule — create the skill. (No legacy seeding: creator_prefs.style_notes
  // is now the RAW follow-up log that rules get distilled FROM, not skill content.)
  const { data, error } = await db.from("creator_skills")
    .insert({ creator_id: cid, name: REFINEMENTS_SKILL, content: line, active: true, scope: "script" })
    .select(COLS).single();
  if (error) throw new Error("appendRefinement insert: " + error.message);
  return data;
}

/** The creator's own promoted rules (the user section of the Refinements skill),
 *  as lines — used by the pattern distiller to avoid re-promoting covered rules. */
export async function getRefinementNotes() {
  const cid = currentCreatorId();
  if (!cid) return [];
  const db = await getDb();
  const { data: rows } = await db.from("creator_skills").select(COLS)
    .eq("creator_id", cid).eq("name", REFINEMENTS_SKILL).order("updated_at", { ascending: false }).limit(1);
  const ex = rows && rows[0];
  if (!ex) return [];
  return splitRefinements(ex.content).user.split("\n").map((l) => l.trim()).filter(Boolean);
}
