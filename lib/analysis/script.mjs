// Generate a NEW reel script from a reference reel's transcript + what made it
// work (the "generate script" button). Also compiles the per-frame visual
// descriptions into prompts for Claude design.
import { getOpenAI, cost } from "./client.mjs";
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

export async function generateScript({ id, transcript, summary, hook, brief = "", model = process.env.OPENAI_SCRIPT_MODEL || process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1" } = {}) {
  const ref = await load(id, transcript ? { transcript, summary, hook } : null);
  const client = await getOpenAI();

  const { activeSkillsText } = await import("../store/skills.mjs");
  const skills = await activeSkillsText("script").catch(() => "");

  const sys =
    "You are a short-form video scriptwriter. Given a reference reel's spoken transcript and what made " +
    "it work, write a NEW, original reel script. Match the reference's LANGUAGE and energy, and keep the " +
    "proven structure (a strong hook in the first 3 seconds, a clear payoff, a call to action at the end), " +
    "but make the content original — do not copy the reference. Output a clean spoken script with light " +
    "scene/visual cues in [brackets]. Keep it tight enough for a 30–60s reel." +
    (skills ? "\n\nAPPLY THE CREATOR'S OWN SKILLS below — they take priority on voice, format and style:\n" + skills : "");

  const user =
    `REFERENCE TRANSCRIPT:\n${ref.transcript || "(none)"}\n\n` +
    `WHAT MADE IT WORK:\n${ref.hook || ""}\n${ref.summary || ""}\n\n` +
    `BRIEF FOR THE NEW SCRIPT:\n${brief || "Same topic and audience as the reference; make it fresh."}`;

  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    max_completion_tokens: 2000,
  });
  return { script: res.choices?.[0]?.message?.content || "", model, costUsd: cost(model, res.usage) };
}

/** Turn the per-frame `visual` descriptions into ready-to-paste image prompts. */
export function visualPrompts(result) {
  const frames = result.frames || [];
  return frames
    .filter((f) => f.visual)
    .map((f) => ({ t: f.t, prompt: f.visual + (f.motion ? ` (${f.motion})` : "") }));
}
