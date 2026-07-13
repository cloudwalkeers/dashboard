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
export async function modelEvidence() {
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

/** The Lab's learnings as condensed one-liners, for ANY script-writing surface.
 *  Studio uses this evidence natively in its prompt; Create→Script injects it too.
 *  = model evidence (hooks, retention, saves) + the supported engagement-rate levers
 *  from the causal ledger. Best-effort: returns [] when there's no data yet. */
export async function labFindings() {
  const out = await modelEvidence();
  try {
    const { analyze } = await import("./causal.mjs");
    const led = (await analyze({ outcome: "rate" })).hypotheses || [];
    for (const h of led.filter((x) => x.status === "supported").slice(0, 4))
      out.push(`Engagement rate: ${humanFeature(h.feature, h.value)} → supported (effect ${h.effect > 0 ? "+" : ""}${h.effect})`);
  } catch { /* optional */ }
  return out;
}

/** Capture a Studio follow-up prompt: log it raw, then promote a rule to the
 *  Refinements skill ONLY when a PATTERN emerges — the same ask recurring (≥2 times in
 *  intent) or feedback explicitly phrased as a standing rule ("immer", "nie", "ab
 *  jetzt", "generell"). One-off, content-specific asks (a specific topic, beat, code or
 *  video) stay in the log and never become standing rules. Fire-and-forget. */
export async function captureRefinementTurn(note) {
  const text = String(note || "").trim();
  if (text.length < 4) return;
  const prefs = await import("./store/prefs.mjs");
  await prefs.addStyleNote(text); // raw follow-up log (hidden; distillation input only)
  const log = await prefs.getStyleNotes();
  if (log.length < 2) return; // a pattern needs at least two data points
  const S = await import("./store/skills.mjs");
  const existing = await S.getRefinementNotes().catch(() => []);
  const client = await getOpenAI();
  const model = process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1";
  const sys =
    "You maintain a creator's STANDING style rules for short-form script generation. From their chronological FOLLOW-UP PROMPT LOG (refinement asks during script sessions), extract only preferences that are DURABLE:\n" +
    "- the same intent recurring (at least twice, in any wording), OR\n" +
    "- feedback explicitly phrased as a standing rule (\"immer\", \"nie\", \"ab jetzt\", \"generell\", \"always\", \"never\").\n" +
    "IGNORE one-off, content-specific asks — a specific topic, beat, scene, code, name or video. Do NOT return rules already covered by the EXISTING RULES. Each rule: one short imperative line in the creator's own language, ≤ 12 words. If nothing qualifies, return an empty list.";
  const user =
    "FOLLOW-UP PROMPT LOG (oldest → newest):\n" + log.map((l) => "- " + l).join("\n") +
    "\n\nEXISTING RULES:\n" + (existing.length ? existing.join("\n") : "(none)");
  const { data } = await completeJson(client, {
    model,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    schema: { type: "object", additionalProperties: false, required: ["rules"], properties: { rules: { type: "array", items: { type: "string" } } } },
    schemaName: "refinement_rules",
    outputBudget: 400,
  });
  for (const r of (data.rules || []).filter((x) => String(x).trim()).slice(0, 3)) await S.appendRefinement(r);
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
  // Standing preferences now flow through the visible Refinements SKILL (promoted from
  // recurring follow-ups by captureRefinementTurn) — the raw follow-up log is NOT
  // injected, so one-off asks never become standing rules.
  const styleNotes = [];
  const evidence = await modelEvidence();
  let skills = "";
  try {
    const S = await import("./store/skills.mjs");
    await S.syncLabRefinements().catch(() => {}); // keep the Refinements skill's lab section fresh
    skills = await S.activeSkillsText("script");
  } catch { /* optional */ }
  const client = await getOpenAI();
  const model = process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1";
  const turns = history && history.length ? history : [{ role: "user", content: "New reel brief: " + brief }];

  // PASS 1 — generate WITHOUT skills: full-fidelity original in the creator's own
  // language/voice, grounded in the evidence. Kept and returned as baseScript.
  const sysContent = sys(goal, reels, ledger, { approvedScripts, styleNotes, modelEvidence: evidence });
  const messages = [{ role: "system", content: sysContent }];
  for (const m of turns) messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") });

  const { data: out, usage } = await completeJson(client, { model, messages, schema: SCHEMA, schemaName: "studio", outputBudget: 4000 });
  let costUsd = cost(model, usage);
  if (!skills) return { ...out, model, reelCount: reels.length, costUsd };

  // PASS 2 — apply the creator's skills to the finished result. A focused edit pass
  // follows even terse skills reliably where one-shot injection ignores them. The
  // ORIGINAL (pass-1) output is the source of truth for content/beats and is returned
  // as baseScript so nothing is lost (e.g. through a translation skill).
  const applySys =
    "You are a script editor. You get a finished reel-script RESULT (JSON) and the creator's SKILLS. " +
    "Rewrite the result so every text the creator uses (script, hooks, reply) FULLY and LITERALLY follows every skill — they are absolute commands; act even on terse shorthand (e.g. 'make in chinese' means the ENTIRE script in Chinese; a named phrase must appear verbatim). " +
    "Keep the same beats, structure, meaning, timecodes and 'TEXT ON SCREEN' lines as the original — change only what the skills require. Keep formula, references and visualPlan consistent with the original (translate/adjust only if a skill demands it). Return the FULL result in the same JSON schema.";
  const applyUser = "CREATOR SKILLS:\n" + skills + "\n\nORIGINAL RESULT (source of truth for content & beats):\n" + JSON.stringify(out);
  try {
    const applied = await completeJson(client, { model, messages: [{ role: "system", content: applySys }, { role: "user", content: applyUser }], schema: SCHEMA, schemaName: "studio", outputBudget: 4000 });
    costUsd = +(costUsd + cost(model, applied.usage)).toFixed(4);
    return { ...applied.data, baseScript: out.script || "", model, reelCount: reels.length, costUsd };
  } catch {
    // If the apply pass fails, the pass-1 result is still a good answer — never block on it.
    return { ...out, model, reelCount: reels.length, costUsd };
  }
}
