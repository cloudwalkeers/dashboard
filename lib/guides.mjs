// Guide generator: turn a reel's transcript into a polished, standalone written guide
// (Markdown), applying the creator's GUIDE-scope skills. Reuses the existing extraction
// pipeline (which caches), so re-generating an already-extracted reel is cheap.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getOpenAI, cost, completeJson } from "./analysis/client.mjs";
import { activeSkillsText } from "./store/skills.mjs";

function runPdftotext(pdfPath, txtPath) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.env.PDFTOTEXT_BIN || "pdftotext", ["-layout", pdfPath, txtPath]);
    let err = "";
    cp.on("error", () => reject(new Error("PDF import needs pdftotext (poppler). It's installed on the deployed server; locally, install poppler or upload a .md/.txt.")));
    cp.stderr.on("data", (d) => (err += d));
    cp.on("close", (code) => (code === 0 ? resolve() : reject(new Error("Couldn't read that PDF" + (err ? ": " + err.slice(0, 120) : ".")))));
  });
}

/** Extract text from an uploaded PDF (base64) via pdftotext. Uses temp FILES (not
 *  stdin/stdout piping) so it works with both poppler (Linux/prod) and the older
 *  Glyph & Cog build on Windows dev. */
export async function extractPdfText(base64) {
  const buffer = Buffer.from(String(base64 || "").replace(/^data:[^,]*,/, ""), "base64");
  if (!buffer.length) throw new Error("Empty PDF.");
  const stamp = Date.now() + "-" + Math.floor(Math.random() * 1e6);
  const pdfPath = join(tmpdir(), `guide-import-${stamp}.pdf`);
  const txtPath = join(tmpdir(), `guide-import-${stamp}.txt`);
  try {
    await writeFile(pdfPath, buffer);
    await runPdftotext(pdfPath, txtPath);
    return (await readFile(txtPath, "utf8")).trim();
  } finally {
    unlink(pdfPath).catch(() => {});
    unlink(txtPath).catch(() => {});
  }
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body_md"],
  properties: {
    title: { type: "string", description: "A compelling, specific guide title (no 'in this video')." },
    body_md: { type: "string", description: "The full guide in Markdown using the design system: a :::requirements opener, numbered :::step blocks, ```prompt fences, and :::tip/:::example/:::note/:::warning callouts. Ends with a short takeaway." },
  },
};

// The house style every guide follows — a real design system the renderer turns into
// boxes/steps (see lib/guideHtml.mjs). Written as plain strings (no backtick-in-template
// escaping) and shared by every generation path so guides look consistent.
const DESIGN_RULES = [
  "STRUCTURE & DESIGN SYSTEM — write these tokens directly into the Markdown body:",
  "1) ONE H1 title, then a 1–2 sentence intro (what the reader will achieve).",
  "2) Right after the intro, a requirements box listing what THIS specific guide actually needs — real tools / accounts / files, and a price ONLY if one genuinely applies. Never invent requirements; a paid plan like ChatGPT Plus is just one possible example, not mandatory:",
  ":::requirements Was brauchst du?",
  "- **<Tool / Konto / Datei>** (nur falls Kosten anfallen: z. B. mind. 20 €/Monat)",
  "- <weitere echte Voraussetzung>",
  ":::",
  "3) The core of EVERY guide is STEP-BY-STEP. Put each step in its own block; the blocks AUTO-NUMBER, so write the step's NAME after :::step (never a digit) and do NOT add an H1/H2 heading inside a step:",
  ":::step Bild vorbereiten",
  "<genau was zu tun ist; hier dürfen Prompts, Tipps und Beispiele stehen>",
  ":::",
  "4) Put every copy-paste PROMPT in a fenced block tagged prompt:",
  "```prompt",
  "<der Prompt>",
  "```",
  "5) Use callouts where they genuinely help (a title after the type is optional):",
  ":::tip <ein konkreter Profi-Tipp> :::",
  ":::example <ein konkretes Beispiel / Ergebnis> :::",
  ":::warning <eine Falle / Warnung> :::",
  ":::note <ein nützlicher Hinweis> :::",
  "6) End with a short takeaway.",
  "TRUTH: state only what is TRUE and verifiable — never invent numbers, prices, features or results. If unsure, tell the reader what to check.",
  "LANGUAGE: match the source; default to German (du-Form) for this creator's audience.",
].join("\n");

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body_md", "changes", "warnings"],
  properties: {
    title: { type: "string" },
    body_md: { type: "string", description: "The FULL improved guide in Markdown, keeping the design system." },
    changes: { type: "array", items: { type: "string" }, description: "Short bullets: what was fixed or added (each ≤ 14 words)." },
    warnings: { type: "array", items: { type: "string" }, description: "Anything the human should double-check before publishing (facts, prices, claims)." },
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
    "Reproduce and IMPROVE any prompts/commands the video references (they can and should be better than the video's). Be concrete and high-quality — no filler, no 'in this video'." +
    "\n\n" + DESIGN_RULES +
    (skills ? "\n\nAPPLY THE CREATOR'S OWN GUIDE SKILLS below — they take priority on structure, voice and format:\n" + skills : "");

  const user =
    `SOURCE TRANSCRIPT:\n${transcript || "(none)"}\n\n` +
    `CAPTION:\n${caption || "(none)"}\n\n` +
    `WHAT MADE THE VIDEO WORK (context, don't quote):\n${hook}\n${summary}`;

  const { data: out, usage } = await completeJson(client, { model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], schema: SCHEMA, schemaName: "guide", outputBudget: 4000 });

  return {
    title: out.title || "Untitled guide",
    body_md: out.body_md || "",
    source_shortcode: result.id || null,
    source_url: url,
    model,
    costUsd: cost(model, usage),
  };
}

/** Compose a guide DRAFT from source material (a reel's transcript and/or uploaded
 *  text) plus the creator's prompt and guide skills. Returns { title, body_md } and
 *  does NOT save — the Create workbench holds it until the creator saves to Inventory. */
export async function composeGuide({ url = null, sourceText = "", brief = "", onStep = () => {} } = {}) {
  let material = String(sourceText || "").trim();
  let source_shortcode = null, source_url = null;
  if (url) {
    const { analyzeFromUrl } = await import("./analysis/web.mjs");
    const result = await analyzeFromUrl(url, { onStep });
    const transcript = (result.transcript && result.transcript.text) || "";
    const caption = (result.metrics && (result.metrics.cap || result.metrics.caption)) || "";
    material = (transcript + "\n\n" + caption).trim();
    source_shortcode = result.id || null; source_url = url;
  }
  if (!material && !String(brief).trim()) throw new Error("Add a reel link, upload a file, or write a prompt.");

  const skills = await activeSkillsText("guide").catch(() => "");
  onStep("writing guide");
  const client = await getOpenAI();
  const model = process.env.OPENAI_GUIDE_MODEL || process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1";

  const sys =
    "You are an expert writer producing a polished, standalone written GUIDE. Expand and reorganize the source material into something genuinely useful that stands on its own and reads BETTER than the source; never copy it verbatim or read like a transcript. Follow the creator's instruction. Be concrete; no filler." +
    "\n\n" + DESIGN_RULES +
    (skills ? "\n\nAPPLY THE CREATOR'S OWN GUIDE SKILLS below — they take priority on structure, voice and format:\n" + skills : "");
  const user =
    (material ? `SOURCE MATERIAL:\n${material}\n\n` : "") +
    `CREATOR'S INSTRUCTION / PROMPT:\n${brief || "Turn the source material into a polished, standalone written guide."}`;

  const { data: out, usage } = await completeJson(client, { model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], schema: SCHEMA, schemaName: "guide", outputBudget: 4000 });
  return { title: out.title || "Untitled guide", body_md: out.body_md || "", source_shortcode, source_url };
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
    "You are an expert writer producing a polished, standalone written GUIDE. Be concrete and genuinely useful; no filler." +
    (reference ? " You are given an EXISTING guide as a starting point: reuse and IMPROVE its strong parts, but write a FRESH, better guide tailored to the brief — never copy it verbatim." : "") +
    "\n\n" + DESIGN_RULES +
    (skills ? "\n\nAPPLY THE CREATOR'S OWN GUIDE SKILLS below — they take priority on structure, voice and format:\n" + skills : "");

  const user =
    `BRIEF / TOPIC:\n${brief || "(base it on the source guide below)"}\n\n` +
    (reference ? `SOURCE GUIDE — "${refTitle}":\n${reference}\n` : "");

  const { data: out, usage } = await completeJson(client, { model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], schema: SCHEMA, schemaName: "guide", outputBudget: 4000 });

  return {
    title: out.title || (String(brief).slice(0, 60) || refTitle || "Untitled guide"),
    body_md: out.body_md || "",
    source_shortcode: null,
    source_url: null,
    model,
    costUsd: cost(model, usage),
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
    "You are refining an existing written GUIDE. Apply the follow-up instruction and return the FULL updated guide — keep what already works, change only what's asked (and whatever that entails). Keep the H1 title unless the instruction implies a new one. PRESERVE the design system already in the guide (the :::requirements opener, numbered :::step blocks, ```prompt fences and :::tip/:::example/:::note/:::warning callouts) and keep using it for anything you add." +
    "\n\n" + DESIGN_RULES +
    (skills ? "\n\nAPPLY THE CREATOR'S GUIDE SKILLS below — they take priority on structure, voice and format:\n" + skills : "");
  const user = `CURRENT GUIDE — "${title}":\n${body_md}\n\nFOLLOW-UP INSTRUCTION:\n${instruction}`;
  const { data: out, usage } = await completeJson(client, { model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], schema: SCHEMA, schemaName: "guide", outputBudget: 4000 });
  return { title: out.title || title, body_md: out.body_md || body_md };
}

/** Final QA + enhancement pass before publishing. Reads the guide as a user would
 *  follow it: fixes anything wrong/unclear/out-of-order, flags anything fake or
 *  unverifiable, and ACTIVELY improves it (a better example, a missing step, a pro
 *  tip, a pitfall, a missing requirement). Returns the full improved guide plus a
 *  short report { changes, warnings }. */
export async function reviewGuide({ title = "", body_md = "" } = {}) {
  if (!String(body_md).trim()) throw new Error("Nothing to review yet — generate or open a guide first.");
  const skills = await activeSkillsText("guide").catch(() => "");
  const client = await getOpenAI();
  const model = process.env.OPENAI_GUIDE_MODEL || process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1";

  const sys =
    "You are a meticulous editor and fact-checker doing the FINAL QA pass on a written guide before it is published. Do BOTH of these:\n" +
    "1) TEST & FIX — read it as a user who will actually follow it. Fix anything wrong, unclear, out of order or incomplete. Check that every prompt/command really does what the text claims and improve weak ones. Remove or clearly flag anything that looks fake, exaggerated or unverifiable — no invented numbers, prices, features or results.\n" +
    "2) MAKE IT BETTER — add genuinely useful extras where they help: a missing step, a better or additional concrete EXAMPLE, a pro TIP, a pitfall WARNING, or a real missing item in the requirements. Don't pad; every addition must earn its place.\n" +
    "Keep the design system and improve its use: a :::requirements box titled Was brauchst du? at the top listing only real requirements; the body as auto-numbering :::step blocks (write the step NAME after :::step, never a digit, and no heading inside a step); copy-paste prompts in ```prompt fences; and :::tip/:::example/:::note/:::warning callouts. Keep the guide's language (German du-Form by default).\n" +
    "Return the FULL improved guide (title + body_md) plus a short report: `changes` = what you fixed/added (each ≤ 14 words), `warnings` = anything the human should double-check (facts, claims, prices). If nothing needed changing, return it unchanged with an empty changes list." +
    (skills ? "\n\nAPPLY THE CREATOR'S GUIDE SKILLS below (priority on structure, voice, format):\n" + skills : "");
  const user = `GUIDE TITLE: ${title}\n\nGUIDE BODY (Markdown):\n${body_md}`;

  const { data: out, usage } = await completeJson(client, { model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], schema: REVIEW_SCHEMA, schemaName: "guide_review", outputBudget: 6000 });
  return {
    title: out.title || title,
    body_md: out.body_md || body_md,
    changes: Array.isArray(out.changes) ? out.changes.filter(Boolean).slice(0, 12) : [],
    warnings: Array.isArray(out.warnings) ? out.warnings.filter(Boolean).slice(0, 8) : [],
    model,
    costUsd: cost(model, usage),
  };
}
