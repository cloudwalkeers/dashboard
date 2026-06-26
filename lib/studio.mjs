// Studio: a RAG-style "what works" advisor. Pulls the creator's reels + their
// real engagement from Supabase, feeds the whole corpus to the model (fine at
// this scale — no vector store needed yet), and generates a script grounded in
// the reels that actually performed, with a chat loop for refinement.
import { getOpenAI, pickJsonFromText, cost } from "./analysis/client.mjs";
import { getDb, isConfigured } from "./store/supabase.mjs";
import { humanFeature } from "./causal.mjs";

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
    const likes = metrics.likes ?? null, plays = metrics.plays ?? null;
    return {
      shortcode: r.shortcode,
      likes, comments: metrics.comments ?? null, plays,
      rate: plays && likes != null ? +(likes / plays * 100).toFixed(2) : null,
      durationSec: r.duration_sec ? Math.round(r.duration_sec) : null,
      hook: r.hook || "",
      summary: r.summary || "",
      transcript: (r.transcript_text || "").slice(0, 280),
    };
  });
}

const sys = (goal, reels, ledger) => {
  const lines = reels
    .slice()
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || (b.likes || 0) - (a.likes || 0))
    .map((r) => `- [${r.shortcode}] rate:${r.rate != null ? r.rate + "%" : "?"} (${r.likes ?? "?"}♥/${r.plays != null ? r.plays + " views" : "? views"}, ${r.comments ?? "?"}💬) · ${r.durationSec ?? "?"}s · hook: "${r.hook.slice(0, 120)}" · ${r.summary.slice(0, 200)}`)
    .join("\n");
  const evid = (ledger && ledger.length)
    ? ledger.filter((h) => h.effect > 0).slice(0, 8).map((h) => `- ${humanFeature(h.feature, h.value)} → ${h.status} (effect ${h.effect > 0 ? "+" : ""}${h.effect}, n=${h.n_with}, conf ${h.confidence}${h.shared_by_losers ? ", but ALSO common in flops → probably not a real edge" : ""})`).join("\n")
    : "(not enough data yet)";
  return `You are an elite short-form video strategist for a German-speaking creator who posts about AI, automation, and tech (Instagram Reels, 9:16, creator in the lower 55% of frame, visuals in the top 45%).

The honest truth about this data: engagement RATE (likes ÷ views) is the real quality signal — raw likes mostly reflect how much REACH the algorithm gave a reel, not how good it was. Use RATE, not raw likes, to judge what worked. Most apparent "patterns" are NOT statistically established at this sample size; treat them as hypotheses, and DO NOT overclaim causation.

CREATOR'S REELS (rate · likes/views · length · hook · summary), best-rate first:
${lines}

DE-CONFOUNDED EVIDENCE LEDGER (contrastive, on rate — already controlled for reach; "supported" = real signal, "weak/inconclusive" = unproven):
${evid}

Optimize primarily for: ${goal}. A "comment <word>" CTA inflates comments via a lead-magnet funnel, so never read high comments as pure resonance.

Ground your "formula" in the EVIDENCE LEDGER above — lead with anything "supported", clearly mark "weak/inconclusive" items as hunches, and never present a pattern that's "ALSO common in flops" as an edge. Write the script and hooks in GERMAN in the creator's punchy direct voice. Return STRICT JSON per the schema: "formula" (evidence-grounded, honesty-tagged), "references" (specific reels + why, prefer high-RATE ones), full "script" (hook → body → CTA), 3 "hooks", a per-scene "visualPlan" (intensity 0–4), and a short "reply".`;
};

/** Generate or refine. history = [{role:'user'|'assistant', content}] chat turns. */
export async function studioGenerate({ brief = "", goal = "likes", history = [] } = {}) {
  const reels = await corpus();
  if (!reels.length) {
    const e = new Error("No analyzed reels in Supabase yet — extract some reels first so the advisor has data to learn from.");
    e.code = "NO_DATA";
    throw e;
  }
  let ledger = [];
  try { const { analyze } = await import("./causal.mjs"); ledger = (await analyze({ outcome: "rate" })).hypotheses || []; } catch (e) { /* ledger optional */ }
  const client = await getOpenAI();
  const model = process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1";
  const turns = history && history.length ? history : [{ role: "user", content: "New reel brief: " + brief }];
  const messages = [{ role: "system", content: sys(goal, reels, ledger) }];
  for (const m of turns) messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") });

  const res = await client.chat.completions.create({
    model, messages,
    response_format: { type: "json_schema", json_schema: { name: "studio", strict: true, schema: SCHEMA } },
    max_completion_tokens: 4000,
  });
  const out = pickJsonFromText(res.choices?.[0]?.message?.content || "{}");
  return { ...out, model, reelCount: reels.length, costUsd: cost(model, res.usage) };
}
