// Studio: a RAG-style "what works" advisor. Pulls the creator's reels + their
// real engagement from Supabase, feeds the whole corpus to the model (fine at
// this scale — no vector store needed yet), and generates a script grounded in
// the reels that actually performed, with a chat loop for refinement.
import { getOpenAI, pickJsonFromText, cost } from "./analysis/client.mjs";
import { getDb, isConfigured } from "./store/supabase.mjs";
import { humanFeature } from "./causal.mjs";
import { currentIgAccount } from "./scope.mjs";

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

/** Pull the creator's analyzed reels + their latest engagement snapshot. */
async function corpus() {
  const db = await getDb();
  let q = db
    .from("reels")
    .select("shortcode,summary,hook,transcript_text,duration_sec,reel_metrics(plays,reach,saves,shares,likes,comments,avg_watch_sec,captured_date)")
    .not("summary", "is", null);
  const acct = currentIgAccount();
  if (acct) q = q.eq("ig_account", acct);
  const { data, error } = await q;
  if (error) throw new Error("studio corpus: " + error.message);
  return (data || []).map((r) => {
    const metrics = (r.reel_metrics || []).slice().sort((a, b) => String(b.captured_date).localeCompare(String(a.captured_date)))[0] || {};
    const likes = metrics.likes ?? null, plays = metrics.plays ?? null;
    const dur = r.duration_sec ? Math.round(r.duration_sec) : null;
    return {
      shortcode: r.shortcode,
      likes, comments: metrics.comments ?? null, plays,
      saves: metrics.saves ?? null, shares: metrics.shares ?? null,
      rate: plays && likes != null ? +(likes / plays * 100).toFixed(2) : null,
      watchPct: plays && dur && metrics.avg_watch_sec ? Math.round((metrics.avg_watch_sec / dur) * 100) : null,
      durationSec: dur,
      hook: r.hook || "",
      summary: r.summary || "",
      transcript: (r.transcript_text || "").slice(0, 400),
    };
  });
}

const sys = (goal, reels, ledger) => {
  const lines = reels
    .slice()
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || (b.likes || 0) - (a.likes || 0))
    .map((r) => `- [${r.shortcode}] rate:${r.rate != null ? r.rate + "%" : "?"} (${r.likes ?? "?"}♥/${r.plays != null ? r.plays + " views" : "? views"}, ${r.comments ?? "?"}💬${r.saves != null ? ", " + r.saves + " saves" : ""}${r.watchPct != null ? ", " + r.watchPct + "% watched" : ""}) · ${r.durationSec ?? "?"}s · hook: "${r.hook.slice(0, 120)}" · ${r.summary.slice(0, 200)}`)
    .join("\n");
  // A voice sample from the creator's best performers, so the script sounds like THEM.
  const voice = reels
    .filter((r) => r.transcript)
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1))
    .slice(0, 3)
    .map((r) => `«${r.transcript.slice(0, 320)}»`)
    .join("\n");
  const evid = (ledger && ledger.length)
    ? ledger.filter((h) => h.effect > 0).slice(0, 8).map((h) => `- ${humanFeature(h.feature, h.value)} → ${h.status} (effect ${h.effect > 0 ? "+" : ""}${h.effect}, n=${h.n_with}, conf ${h.confidence}${h.shared_by_losers ? ", but ALSO common in flops → probably not a real edge" : ""})`).join("\n")
    : "(not enough data yet)";
  return `You are an elite short-form scriptwriter and retention strategist (Instagram Reels / TikTok / Shorts, 9:16). You write scripts that real humans can say out loud — and that hold viewers second by second.

VOICE — this is non-negotiable:
- Write in the creator's own language and voice. Infer BOTH from the transcript samples below (their actual spoken words). Do not translate them into another language; do not smooth their style into generic "influencer speak".
- Spoken language, not written language: short sentences. Contractions. Concrete words. It must pass the read-aloud test — if a sentence would sound scripted when said to a friend, rewrite it.
- Banned: "in today's video", "welcome back", "let's dive in", "game-changer", "unleash", any greeting before the hook, any sentence that only exists to sound smart.

TRANSCRIPT SAMPLES from their best reels (voice + language reference):
${voice || "(no transcripts yet — use a neutral, direct spoken voice)"}

VIEWS MECHANICS — structure every script for retention:
- 0–2s HOOK: the single most important line. It must open a curiosity gap or make a sharp claim in the FIRST spoken words, with matching on-screen text. Never start with context.
- Then a fast "why should I care" beat (2–6s), then payoffs in a tight cadence — a new concrete beat every 3–6 seconds. Each beat earns the next second of watching.
- One open loop stays open until the final beat (that's what carries completion).
- End: payoff lands, then ONE short CTA — never before the value is delivered.
- Default length 25–45s unless the creator's own data says their longer reels hold (check watch % in the reel list).

THE DATA (honesty rules): engagement RATE (likes ÷ views) is the quality signal — raw likes mostly reflect how much REACH the algorithm handed a reel. Judge "what worked" by rate, saves and watched-%. Most apparent patterns at this sample size are hypotheses, not facts — do not overclaim causation.

CREATOR'S REELS (rate · likes/views · saves · watched % · length · hook · summary), best-rate first:
${lines}

DE-CONFOUNDED EVIDENCE LEDGER (contrastive, on rate — already controlled for reach; "supported" = real signal, "weak/inconclusive" = unproven):
${evid}

Optimize primarily for: ${goal}. A "comment <word>" CTA inflates comments via a lead-magnet funnel, so never read high comments as pure resonance.

Ground your "formula" in the EVIDENCE LEDGER — lead with anything "supported", clearly mark "weak/inconclusive" items as hunches, and never present a pattern that's "ALSO common in flops" as an edge.

Return STRICT JSON per the schema:
- "formula": the evidence-grounded recipe, honesty-tagged.
- "references": specific reels + why (prefer high-RATE ones).
- "script": the full script formatted with timecoded beats, each on its own line: "[0:00] (spoken) …" plus "TEXT ON SCREEN: …" where it matters. Hook → beats → payoff → CTA.
- "hooks": 3 alternative first-lines (each ≤ 12 spoken words, no greetings).
- "visualPlan": per-scene, intensity 0–4.
- "reply": one short conversational note to the creator.`;
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
