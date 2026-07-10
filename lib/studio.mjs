// Studio: a RAG-style "what works" advisor. Pulls the creator's reels + their
// real engagement from Supabase, feeds the whole corpus to the model (fine at
// this scale — no vector store needed yet), and generates a script grounded in
// the reels that actually performed, with a chat loop for refinement.
import { getOpenAI, cost, completeJson } from "./analysis/client.mjs";
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

const sys = (goal, reels, ledger, extra = {}) => {
  const lines = reels
    .slice()
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || (b.likes || 0) - (a.likes || 0))
    .map((r) => `- [${r.shortcode}] rate:${r.rate != null ? r.rate + "%" : "?"} (${r.likes ?? "?"}♥/${r.plays != null ? r.plays + " views" : "? views"}, ${r.comments ?? "?"}💬${r.saves != null ? ", " + r.saves + " saves" : ""}${r.watchPct != null ? ", " + r.watchPct + "% watched" : ""}) · ${r.durationSec ?? "?"}s · hook: "${r.hook.slice(0, 120)}" · ${r.summary.slice(0, 200)}`)
    .join("\n");
  // The creator's real spoken words — the primary voice reference.
  const voice = reels
    .filter((r) => r.transcript)
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1))
    .slice(0, 5)
    .map((r) => `«${r.transcript.slice(0, 500)}»`)
    .join("\n");
  const evid = (ledger && ledger.length)
    ? ledger.filter((h) => h.effect > 0).slice(0, 8).map((h) => `- ${humanFeature(h.feature, h.value)} → ${h.status} (effect ${h.effect > 0 ? "+" : ""}${h.effect}, n=${h.n_with}, conf ${h.confidence}${h.shared_by_losers ? ", but ALSO common in flops → probably not a real edge" : ""})`).join("\n")
    : "(not enough data yet)";
  const approved = (extra.approvedScripts || []).length
    ? extra.approvedScripts.map((s, i) => `── APPROVED SCRIPT ${i + 1}: "${s.title}" ──\n${s.text}`).join("\n\n")
    : "";
  const notes = (extra.styleNotes || []).length
    ? extra.styleNotes.map((n) => `- ${n}`).join("\n")
    : "";
  const models = (extra.modelEvidence || []).length
    ? extra.modelEvidence.map((m) => `- ${m}`).join("\n")
    : "(models still training — lean on the ledger + reel list)";
  return `You are an elite short-form scriptwriter and retention strategist (Instagram Reels / TikTok / Shorts, 9:16). You write scripts that real humans say out loud — and that hold viewers second by second.

VOICE — this is the #1 requirement. The creator has rejected scripts for "not sounding like me".
- Write ONLY in the creator's own language and register, learned from the material below. Their APPROVED SCRIPTS and TRANSCRIPTS define the voice — sentence length, energy, how they open, how they ask.
- Reuse the creator's own recurring words, connectors and verbal tics. NEVER import slang, hype-words or idioms that do not appear in their material — if they don't say it, you don't write it.
- Spoken language: short sentences, contractions, concrete words. Read-aloud test — if a line would sound scripted said to a friend, rewrite it.
- Banned: greetings before the hook, "in today's video", "let's dive in", "game-changer", forced humor, any sentence that only exists to sound clever.
${approved ? `
THE CREATOR'S APPROVED SCRIPTS — the strongest style reference; match their formatting, rhythm and voice exactly:
${approved}
` : ""}
TRANSCRIPT SAMPLES from their best reels (how they actually talk):
${voice || "(no transcripts yet — use a neutral, direct spoken voice)"}
${notes ? `
THE CREATOR'S STANDING NOTES — accumulated from their past refinements; treat every one as a hard requirement:
${notes}
` : ""}
OPTIMIZE THE WHOLE FUNNEL — hold → complete → save/share → views (goal "${goal}" only breaks ties). Structure:
- 0–2s HOOK: curiosity gap or sharp claim in the FIRST spoken words + matching on-screen text. Never open with context.
- A "why should I care" beat by 2–6s, then a new concrete payoff every 3–6 seconds — each beat earns the next second. Design explicitly against the creator's measured drop-offs (see model findings).
- One open loop stays open until the final beat (that's completion). Build in one save-worthy moment (a compact list, template or number worth keeping).
- CTA: exactly one, AFTER the value lands. A "comment <word>" CTA inflates comments via the lead-magnet funnel — use it deliberately, never read it as resonance.
- Length: default 25–45s, but FOLLOW THE CREATOR'S DATA (watched-% by length in the reel list) over the default.

WHAT THIS CREATOR'S MODELS SAY (measured on their own reels — retention, skip, hooks, views; treat "supported" as real, the rest as hunches):
${models}

CREATOR'S REELS (rate · likes/views · saves · watched % · length · hook · summary), best-rate first:
${lines}

DE-CONFOUNDED EVIDENCE LEDGER (contrastive — already controlled for reach):
${evid}

HONESTY RULES: engagement RATE (likes ÷ views), saves and watched-% are the quality signals — raw likes mostly reflect reach the algorithm handed out. Small samples = hypotheses, not facts; never overclaim causation. Ground "formula" in supported evidence first; mark hunches as hunches; never present a pattern that's "ALSO common in flops" as an edge.

Return STRICT JSON per the schema:
- "formula": the evidence-grounded recipe, honesty-tagged.
- "references": specific reels + why (prefer high-RATE ones).
- "script": full script with timecoded beats, one per line: "[0:00] (spoken) …" plus "TEXT ON SCREEN: …" where it matters. Hook → beats → payoff → CTA.
- "hooks": 3 alternative first-lines (each ≤ 12 spoken words, no greetings).
- "visualPlan": per-scene, intensity 0–4.
- "reply": one short conversational note to the creator.`;
};

/** Model findings across the whole funnel, condensed for the prompt. Best-effort —
 *  each source is optional and skipped when its data isn't there yet. */
async function modelEvidence() {
  const out = [];
  // Hook patterns: what the opening line does to skip + 3s hold (deterministic).
  try {
    const hooks = await import("./hooks.mjs");
    const h = await hooks.hookAnalysis();
    for (const p of (h.patterns || []).slice(0, 4)) {
      if (p.n >= 3 && (p.skipDelta != null || p.holdDelta != null))
        out.push(`Hook pattern "${p.label}" (n=${p.n}): skip ${p.skipDelta > 0 ? "+" : ""}${p.skipDelta ?? "?"}pp, 3s-hold ${p.holdDelta > 0 ? "+" : ""}${p.holdDelta ?? "?"}pp vs your average`);
    }
  } catch { /* optional */ }
  // Attention model: on-screen levers that hold or bleed viewers per second.
  try {
    const att = global.__attCache && global.__attCache.data;
    for (const d of ((att && att.drivers) || []).slice(0, 5)) {
      if (d.label && d.effect != null)
        out.push(`Per-second retention: "${d.label}" → ${d.effect > 0 ? "+" : ""}${d.effect}pp/s ${d.effect > 0 ? "(bleeds viewers — avoid/shorten)" : "(holds viewers — lean in)"}`);
    }
  } catch { /* optional */ }
  // Causal contrasts on save-rate (the save-worthiness levers).
  try {
    const { analyze } = await import("./causal.mjs");
    const sv = await analyze({ outcome: "save_rate" });
    for (const h of (sv.hypotheses || []).filter((x) => x.status === "supported").slice(0, 3))
      out.push(`Saves: ${humanFeature(h.feature, h.value)} → supported (effect ${h.effect > 0 ? "+" : ""}${h.effect} on save-rate)`);
  } catch { /* optional */ }
  return out;
}

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
  // The creator's own approved scripts (saved to the Pipeline) — strongest style reference.
  let approvedScripts = [];
  try {
    const scripts = await import("./store/scripts.mjs");
    approvedScripts = (await scripts.listScripts())
      .filter((s) => (s.script || "").length > 150)
      .slice(0, 3)
      .map((s) => ({ title: s.title || "Untitled", text: String(s.script).slice(0, 900) }));
  } catch { /* optional */ }
  // Standing notes accumulated from past refinements ("punchier hooks", "no anglicisms"…).
  let styleNotes = [];
  try { const prefs = await import("./store/prefs.mjs"); styleNotes = await prefs.getStyleNotes(); } catch { /* optional */ }
  const evidence = await modelEvidence();
  let skills = "";
  try { skills = await (await import("./store/skills.mjs")).activeSkillsText("script"); } catch { /* optional */ }
  const client = await getOpenAI();
  const model = process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1";
  const turns = history && history.length ? history : [{ role: "user", content: "New reel brief: " + brief }];
  const sysContent = sys(goal, reels, ledger, { approvedScripts, styleNotes, modelEvidence: evidence })
    + (skills ? "\n\nAPPLY THE CREATOR'S OWN SKILLS below — highest priority on voice, format and style:\n" + skills : "");
  const messages = [{ role: "system", content: sysContent }];
  for (const m of turns) messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") });

  const { data: out, usage } = await completeJson(client, { model, messages, schema: SCHEMA, schemaName: "studio", outputBudget: 4000 });
  return { ...out, model, reelCount: reels.length, costUsd: cost(model, usage) };
}
