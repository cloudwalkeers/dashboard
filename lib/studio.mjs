// Studio: a RAG-style "what works" advisor. Pulls the creator's reels + their
// real engagement from Supabase, feeds the whole corpus to the model (fine at
// this scale — no vector store needed yet), and generates a script grounded in
// the reels that actually performed, with a chat loop for refinement.
import { getOpenAI, pickJsonFromText, cost } from "./analysis/client.mjs";
import { getDb, isConfigured } from "./store/supabase.mjs";

export { isConfigured };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["formula", "references", "script", "hooks", "visualPlan", "reply"],
  properties: {
    formula: { type: "array", items: { type: "string" } },
    references: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["shortcode", "likes", "comments", "why"],
        properties: { shortcode: { type: "string" }, likes: { type: "integer" }, comments: { type: "integer" }, why: { type: "string" } },
      },
    },
    script: { type: "string" },
    hooks: { type: "array", items: { type: "string" } },
    visualPlan: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["scene", "intensity", "note"],
        properties: { scene: { type: "string" }, intensity: { type: "integer" }, note: { type: "string" } },
      },
    },
    reply: { type: "string" },
  },
};

/** Pull every analyzed reel + its latest engagement snapshot. */
async function corpus() {
  const db = await getDb();
  const { data, error } = await db
    .from("reels")
    .select("shortcode,summary,hook,transcript_text,duration_sec,reel_metrics(likes,comments,captured_date)")
    .not("summary", "is", null);
  if (error) throw new Error("studio corpus: " + error.message);
  return (data || []).map((r) => {
    const metrics = (r.reel_metrics || []).slice().sort((a, b) => String(b.captured_date).localeCompare(String(a.captured_date)))[0] || {};
    return {
      shortcode: r.shortcode,
      likes: metrics.likes ?? null,
      comments: metrics.comments ?? null,
      durationSec: r.duration_sec ? Math.round(r.duration_sec) : null,
      hook: r.hook || "",
      summary: r.summary || "",
      transcript: (r.transcript_text || "").slice(0, 280),
    };
  });
}

const sys = (goal, reels) => {
  const lines = reels
    .slice()
    .sort((a, b) => (b.likes || 0) - (a.likes || 0))
    .map((r) => `- [${r.shortcode}] ${r.likes ?? "?"}♥ ${r.comments ?? "?"}💬 · ${r.durationSec ?? "?"}s · hook: "${r.hook.slice(0, 130)}" · ${r.summary.slice(0, 230)}`)
    .join("\n");
  return `You are an elite short-form video strategist for a German-speaking creator who posts about AI, automation, and tech (Instagram Reels, 9:16, creator in the lower 55% of frame, visuals in the top 45%).

Below are the creator's OWN past reels with real engagement. Learn what distinguishes the high-engagement reels from the low ones for THIS creator specifically — do not give generic advice.

CREATOR'S REELS (engagement · length · hook · summary):
${lines}

Optimize primarily for: ${goal}. IMPORTANT: a "comment <word>" CTA inflates comments via a lead-magnet funnel, so weight LIKES as the signal of content quality and treat comments as CTA effectiveness, not pure resonance.

Write the script and hooks in GERMAN, in the creator's punchy direct voice. Be concrete and specific to the data above (cite real reels). Return STRICT JSON per the schema: a "formula" (the concrete patterns that win for this creator), "references" (the specific reels you drew from + why), a full "script" (hook → body → CTA), 3 alternative "hooks", a per-scene "visualPlan" (intensity 0–4), and a short conversational "reply" describing what you did or changed.`;
};

/** Generate or refine. history = [{role:'user'|'assistant', content}] chat turns. */
export async function studioGenerate({ brief = "", goal = "likes", history = [] } = {}) {
  const reels = await corpus();
  if (!reels.length) {
    const e = new Error("No analyzed reels in Supabase yet — extract some reels first so the advisor has data to learn from.");
    e.code = "NO_DATA";
    throw e;
  }
  const client = await getOpenAI();
  const model = process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1";
  const turns = history && history.length ? history : [{ role: "user", content: "New reel brief: " + brief }];
  const messages = [{ role: "system", content: sys(goal, reels) }];
  for (const m of turns) messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") });

  const res = await client.chat.completions.create({
    model, messages,
    response_format: { type: "json_schema", json_schema: { name: "studio", strict: true, schema: SCHEMA } },
    max_completion_tokens: 4000,
  });
  const out = pickJsonFromText(res.choices?.[0]?.message?.content || "{}");
  return { ...out, model, reelCount: reels.length, costUsd: cost(model, res.usage) };
}
