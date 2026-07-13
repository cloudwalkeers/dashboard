// Generate a NEW reel script from a reference reel's transcript + what made it
// work (the "generate script" button). Also compiles the per-frame visual
// descriptions into prompts for Claude design.
import { getOpenAI, cost, tune } from "./client.mjs";
import { getStoredReel } from "../store/supabase.mjs";

async function load(id, provided) {
  if (provided && provided.transcript) return provided;
  if (id) {
    const r = await getStoredReel(id).catch(() => null);
    if (r)
      return {
        transcript: r.transcript?.text || "",
        summary: r.analysis?.summary || "",
        hook: r.analysis?.hook || "",
        frames: r.frames || [],
        lang: r.transcript?.lang || "",
      };
  }
  return provided || {};
}

/** PASS 2 — apply the creator's skills to an already-written script. A focused edit
 *  pass follows even terse skills reliably (verified: one-shot injection ignores
 *  "make in chinese"; this pass acts on it). The ORIGINAL script is the source of
 *  truth for content and beats — so nothing is lost through e.g. a translation. */
export async function applySkillsToScript(client, { script, skills, model }) {
  const sys =
    "You are a script editor. Rewrite the ORIGINAL SCRIPT so it FULLY and LITERALLY follows every one of the CREATOR SKILLS. " +
    "The skills are absolute commands from the creator — act even on terse shorthand (e.g. 'make in chinese' means output the ENTIRE script in Chinese; a skill naming a phrase means include it verbatim). " +
    "Keep the same beats, structure, meaning and scene cues as the original — change ONLY what the skills require. Output ONLY the revised script.";
  const user = "CREATOR SKILLS:\n" + skills + "\n\nORIGINAL SCRIPT:\n" + script;
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    ...tune(model, 2000),
  });
  return { script: res.choices?.[0]?.message?.content || script, usage: res.usage };
}

export async function generateScript({ id, transcript, summary, hook, brief = "", model = process.env.OPENAI_SCRIPT_MODEL || process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1" } = {}) {
  const ref = await load(id, transcript ? { transcript, summary, hook } : null);
  const client = await getOpenAI();

  const { activeSkillsText } = await import("../store/skills.mjs");
  const skills = await activeSkillsText("script").catch(() => "");

  // PASS 1 — pure generation from the reference (no skills): full fidelity to the
  // reference's language, energy and structure. This is the ORIGINAL kept for the creator.
  const sys =
    "You are a short-form video scriptwriter. Given a reference reel's spoken transcript and what made " +
    "it work, write a NEW, original reel script. Match the reference's LANGUAGE and energy, and keep the " +
    "proven structure (a strong hook in the first 3 seconds, a clear payoff, a call to action at the end), " +
    "but make the content original — do not copy the reference. Output a clean spoken script with light " +
    "scene/visual cues in [brackets]. Keep it tight enough for a 30–60s reel.";

  const user =
    `REFERENCE TRANSCRIPT:\n${ref.transcript || "(none)"}\n\n` +
    `WHAT MADE IT WORK:\n${ref.hook || ""}\n${ref.summary || ""}\n\n` +
    `BRIEF FOR THE NEW SCRIPT:\n${brief || "Same topic and audience as the reference; make it fresh."}`;

  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    ...tune(model, 2000),
  });
  const base = res.choices?.[0]?.message?.content || "";
  let costUsd = cost(model, res.usage);
  if (!skills || !base.trim()) return { script: base, model, costUsd };

  // PASS 2 — apply the creator's skills to the finished script (original kept alongside).
  const applied = await applySkillsToScript(client, { script: base, skills, model });
  costUsd = +(costUsd + cost(model, applied.usage)).toFixed(4);
  return { script: applied.script, baseScript: base, model, costUsd };
}

/** Turn the per-frame `visual` descriptions into ready-to-paste image prompts. */
export function visualPrompts(result) {
  const frames = result.frames || [];
  return frames
    .filter((f) => f.visual)
    .map((f) => ({ t: f.t, prompt: f.visual + (f.motion ? ` (${f.motion})` : "") }));
}
