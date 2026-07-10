// Guide generator: turn a reel's transcript into a polished, standalone written guide
// (Markdown), applying the creator's GUIDE-scope skills. Reuses the existing extraction
// pipeline (which caches), so re-generating an already-extracted reel is cheap.
import { getOpenAI, cost } from "./analysis/client.mjs";
import { activeSkillsText } from "./store/skills.mjs";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body_md"],
  properties: {
    title: { type: "string", description: "A compelling, specific guide title (no 'in this video')." },
    body_md: { type: "string", description: "The full guide in Markdown: intro, H2 sections, steps, fenced code blocks for any prompts/commands, a short takeaway." },
  },
};

export async function generateGuide(url, { onStep = () => {} } = {}) {
  const { analyzeFromUrl } = await import("./analysis/web.mjs");
  const result = await analyzeFromUrl(url, { onStep });
  const transcript = (result.transcript && result.transcript.text) || "";
  const caption = (result.metrics && (result.metrics.cap || result.metrics.caption)) || "";
  const summary = (result.analysis && result.analysis.summary) || "";
  const hook = (result.analysis && result.analysis.hook) || "";
  if (!transcript.trim() && !caption.trim()) throw new Error("Couldn't get a transcript or caption from that reel.");

  const skills = await activeSkillsText("guide").catch(() => "");
  onStep("writing guide");
  const client = await getOpenAI();
  const model = process.env.OPENAI_GUIDE_MODEL || process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1";

  const sys =
    "You are an expert writer who turns a short-form video into a polished, standalone written GUIDE that reads beautifully on a web page. " +
    "Expand and reorganize the source into a genuinely useful article: it must stand on its own, be MORE thorough and better structured than the video, and never read like a transcript. " +
    "Write clean Markdown — a specific H1 title, a short intro stating what the reader will get, clear H2 sections, ordered steps where relevant, and a short takeaway at the end. " +
    "If the video references prompts, commands or code, reproduce and IMPROVE them as fenced code blocks (the prompts can and should be better than the video's). " +
    "Match the source LANGUAGE. Be concrete and high-quality — no filler, no 'in this video'." +
    (skills ? "\n\nAPPLY THE CREATOR'S OWN GUIDE SKILLS below — they take priority on structure, voice and format:\n" + skills : "");

  const user =
    `SOURCE TRANSCRIPT:\n${transcript || "(none)"}\n\n` +
    `CAPTION:\n${caption || "(none)"}\n\n` +
    `WHAT MADE THE VIDEO WORK (context, don't quote):\n${hook}\n${summary}`;

  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    response_format: { type: "json_schema", json_schema: { name: "guide", strict: true, schema: SCHEMA } },
    max_completion_tokens: 4000,
  });
  let out = {};
  try { out = JSON.parse(res.choices?.[0]?.message?.content || "{}"); } catch { /* keep defaults */ }

  return {
    title: out.title || "Untitled guide",
    body_md: out.body_md || "",
    source_shortcode: result.id || null,
    source_url: url,
    model,
    costUsd: cost(model, res.usage),
  };
}

/** Guide from a written prompt (+ optional existing guide as a starting point), the
 *  way Studio works for scripts: a brief + the creator's guide skills → a fresh guide.
 *  No video/transcript involved. */
export async function generateGuideFromPrompt({ brief = "", sourceId = null } = {}) {
  if (!String(brief).trim() && !sourceId) throw new Error("Give a topic/prompt, or pick a source guide.");
  let reference = "", refTitle = "";
  if (sourceId) {
    const { getGuide } = await import("./store/guides.mjs");
    const g = await getGuide(sourceId);
    if (g) { reference = g.body_md || ""; refTitle = g.title || ""; }
  }
  const skills = await activeSkillsText("guide").catch(() => "");
  const client = await getOpenAI();
  const model = process.env.OPENAI_GUIDE_MODEL || process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1";

  const sys =
    "You are an expert writer producing a polished, standalone written GUIDE in clean Markdown — a specific H1 title, a short intro, clear H2 sections, ordered steps where relevant, fenced code blocks for any prompts/commands, and a short takeaway. Be concrete and genuinely useful; no filler." +
    (reference ? " You are given an EXISTING guide as a starting point: reuse and IMPROVE its strong parts, but write a FRESH, better guide tailored to the brief — never copy it verbatim." : "") +
    (skills ? "\n\nAPPLY THE CREATOR'S OWN GUIDE SKILLS below — they take priority on structure, voice and format:\n" + skills : "");

  const user =
    `BRIEF / TOPIC:\n${brief || "(base it on the source guide below)"}\n\n` +
    (reference ? `SOURCE GUIDE — "${refTitle}":\n${reference}\n` : "");

  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    response_format: { type: "json_schema", json_schema: { name: "guide", strict: true, schema: SCHEMA } },
    max_completion_tokens: 4000,
  });
  let out = {};
  try { out = JSON.parse(res.choices?.[0]?.message?.content || "{}"); } catch { /* defaults */ }

  return {
    title: out.title || (String(brief).slice(0, 60) || refTitle || "Untitled guide"),
    body_md: out.body_md || "",
    source_shortcode: null,
    source_url: null,
    model,
    costUsd: cost(model, res.usage),
  };
}

/** Iterate on an existing guide with a follow-up instruction (keeps guide skills).
 *  Returns the full updated title + body. */
export async function refineGuide({ title = "", body_md = "", instruction = "" } = {}) {
  if (!String(instruction).trim()) throw new Error("Give a follow-up instruction.");
  const skills = await activeSkillsText("guide").catch(() => "");
  const client = await getOpenAI();
  const model = process.env.OPENAI_GUIDE_MODEL || process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1";
  const sys =
    "You are refining an existing written GUIDE. Apply the follow-up instruction and return the FULL updated guide in clean Markdown — keep what already works, change only what's asked (and whatever that entails). Keep the H1 title unless the instruction implies a new one." +
    (skills ? "\n\nAPPLY THE CREATOR'S GUIDE SKILLS below — they take priority on structure, voice and format:\n" + skills : "");
  const user = `CURRENT GUIDE — "${title}":\n${body_md}\n\nFOLLOW-UP INSTRUCTION:\n${instruction}`;
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    response_format: { type: "json_schema", json_schema: { name: "guide", strict: true, schema: SCHEMA } },
    max_completion_tokens: 4000,
  });
  let out = {};
  try { out = JSON.parse(res.choices?.[0]?.message?.content || "{}"); } catch { /* defaults */ }
  return { title: out.title || title, body_md: out.body_md || body_md };
}
