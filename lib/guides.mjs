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
