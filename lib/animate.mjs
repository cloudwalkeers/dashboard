// Script -> animation breakdown, in the exact format the creator wants: the video
// is split into sections by WHAT HAPPENS (derived entirely from the script), and
// each section gets (a) the German narration line, (b) a detailed English
// directorial animation brief (ASOS-example quality), and (c) the storyboard
// frames as detailed on-screen specs (to render the mockups in Claude Design).
import { getOpenAI, pickJsonFromText, cost } from "./analysis/client.mjs";

// gpt-5 / o-series are reasoning models: they spend max_completion_tokens on hidden
// reasoning before any visible output. Cap that reasoning so tokens go to the answer
// (and so a tight token budget doesn't come back empty). No-op on gpt-4.x.
function reasoningOpts(model) { return /^(gpt-5|o[0-9])/i.test(model || "") ? { reasoning_effort: "low" } : {}; }

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "sections"],
  properties: {
    title: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "time", "narration", "animation", "frames"],
        properties: {
          label: { type: "string" },
          time: { type: "string" },
          narration: { type: "string" },
          animation: { type: "string" },
          frames: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["caption", "visual"],
              properties: { caption: { type: "string" }, visual: { type: "string" } },
            },
          },
        },
      },
    },
  },
};

const SYS = `Du bist Animation Director / Storyboard-Artist für einen deutschsprachigen KI-Influencer. Aus einem Skript mit Zeitstempeln baust du ein ANIMATION-BREAKDOWN. Die Struktur (Anzahl & Art der Sektionen) kommt KOMPLETT aus dem, was im Video passiert — jedes Video ist anders, nichts ist vorgegeben.

Teile das Skript in SEKTIONEN nach Handlung/Schritt. Pro Sektion:
- "label": kurzer Titel (z.B. "1. Contract Reviewer", "Suche & Rabattcodes", "Installation").
- "time": Zeitstempel oder -bereich aus dem Skript (z.B. "0:31" oder "0:31 – 0:41").
- "narration": das wörtliche deutsche Skript-Zitat dieses Moments.
- "animation": eine DETAILLIERTE, KONKRETE Regie-Anweisung auf ENGLISCH — was genau animiert wird, im Stil eines Profi-Briefs. Beschreibe konkrete UI-Zustände, exakte On-Screen-Texte, die Sequenz, Übergänge UND das Ziel/Gefühl. Genau diese Qualität/Spezifität:
    • "Show ChatGPT opening its built-in browser. It automatically navigates to ASOS, searches for 'Carhartt WIP Terrace Football T-Shirt Blue', and selects the exact product. Demonstrate autonomous browsing without any user interaction."
    • "ChatGPT adds the item to the cart and opens checkout. Show several realistic coupon attempts in sequence with smooth animations: WELCOME10 → Invalid, SPRING20 → Brand excluded, SAVE15 → Expired, then FIRSTSHOP → Applying…. Failed codes show realistic red error messages before the next code is tested."
  Erfinde plausible konkrete Details (Namen, Codes, Preise, Button-Texte, Status-Meldungen), wenn das Skript sie nicht nennt — exakt wie im Beispiel. Keine generischen Floskeln.
- "frames": die einzelnen Storyboard-Frames dieses Moments, in Reihenfolge (typisch 2–5). Pro Frame:
    - "caption": kurzes deutsches Label (z.B. "Produkt im Warenkorb", "Code WELCOME10 ungültig").
    - "visual": SEHR detaillierte On-Screen-Beschreibung, 1:1 in Claude Design renderbar — exaktes Interface (z.B. "ASOS Mobile, 16:50 Statusbar"), genaue Texte (Produktname, Preis "€89,00", Code-Feld, Fehlertext "This code is invalid or has expired" in Rot), Buttons, Farben, Layout.

Konkret, spezifisch, kein Geschwafel. Strict JSON nach Schema.`;

// Reverse-engineer an ALREADY-EXTRACTED reel: take its analyzed frames (time,
// visual, motion, on-screen text) + transcript, group them into scenes/sections
// by what happens, and write a per-section animation brief. The real frames
// (with their actual images) are attached back by time — so the UI shows the
// genuine animation, frame by frame, plus an editable spec to re-render clean.
const REEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "sections"],
  properties: {
    title: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "tStart", "tEnd", "narration", "animation"],
        properties: {
          label: { type: "string" },
          tStart: { type: "number" },
          tEnd: { type: "number" },
          narration: { type: "string" },
          animation: { type: "string" },
        },
      },
    },
  },
};

export async function breakdownReel({ frames = [], transcript = null } = {}) {
  if (!frames || !frames.length) {
    const e = new Error("This reel has no extracted frames — extract it first.");
    e.code = "NO_FRAMES";
    throw e;
  }
  const client = await getOpenAI();
  const model = process.env.OPENAI_STORYBOARD_MODEL || process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1";
  const segs = (transcript && transcript.segments) || [];
  const frameLines = frames.map((f) => `t=${f.t}s | visual: ${f.visual || ""} | motion: ${f.motion || ""}${(f.text && f.text.length) ? (" | on-screen text: " + f.text.map((t) => t.content).join("; ")) : ""}`).join("\n");
  const transLines = segs.map((s) => `${s.start}-${s.end}s: ${s.text}`).join("\n");
  const SYS = `Du reverse-engineerst die ANIMATIONEN / UI-VISUALS eines bestehenden Reels — die eingeblendeten Grafiken, App-/Web-Interfaces, Overlays, Diagramme. IGNORIERE die sprechende Person / den Talking Head: es geht NUR um die UI-Visuals. Reine Talking-Head-Momente OHNE eingeblendete Grafik lässt du WEG.
Input: analysierte FRAMES (Zeit, visual, motion, on-screen text) + TRANSCRIPT. Teile die UI-Visuals in SEKTIONEN (eine pro Grafik-/UI-Moment / Schritt). Pro Sektion:
- "label": kurzer Titel.
- "tStart"/"tEnd": Start/Ende in Sekunden (in Reihenfolge, decke die UI-Momente ab).
- "narration": gesprochenes Zitat in dieser Zeit.
- "animation": ENGLISCHER, konkreter Brief NUR der UI-Animation — was sich auf dem Screen aufbaut/bewegt (Overlays, Diagramme, App-Flows, Übergänge), OHNE Person.
Strict JSON nach Schema.`;
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "system", content: SYS }, { role: "user", content: "FRAMES:\n" + frameLines + "\n\nTRANSCRIPT:\n" + transLines }],
    response_format: { type: "json_schema", json_schema: { name: "reel_breakdown", strict: true, schema: REEL_SCHEMA } },
    max_completion_tokens: 6000,
    ...reasoningOpts(model),
  });
  const out = pickJsonFromText(res.choices?.[0]?.message?.content || "{}");
  const sections = (out.sections || []).map((sec) => {
    const inRange = frames.filter((f) => f.t >= sec.tStart - 0.01 && f.t <= sec.tEnd + 0.01);
    const picked = inRange.length <= 2 ? inRange : [inRange[0], inRange[Math.floor(inRange.length / 2)], inRange[inRange.length - 1]].filter((v, i, a) => a.indexOf(v) === i);
    return {
      label: sec.label, time: fmtT(sec.tStart) + "–" + fmtT(sec.tEnd), narration: sec.narration || "", animation: sec.animation || "",
      frames: picked.map((f) => ({ img: f.img, caption: (f.text && f.text[0] && f.text[0].content) ? String(f.text[0].content).slice(0, 50) : fmtT(f.t), visual: f.visual || "" })),
    };
  });
  return { title: out.title || "Reel animation breakdown", sections, model, costUsd: cost(model, res.usage) };
}
function fmtT(s) { s = Math.round(s || 0); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }

// Render ONE frame's visual description as a self-contained HTML phone mockup,
// so the dashboard can show an actual picture (in an iframe) — not just text.
export async function renderFrame(visual, { context = "", imageDataUrl = null } = {}) {
  if (!imageDataUrl && (!visual || !visual.trim())) {
    const e = new Error("No frame to render.");
    e.code = "NO_VISUAL";
    throw e;
  }
  const client = await getOpenAI();
  const model = process.env.OPENAI_RENDER_MODEL || process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1";
  const SYS = `You are a senior product designer. Output ONE self-contained HTML document (inline CSS only, NO external assets, NO JavaScript) that recreates the on-screen UI / graphic / overlay as a clean, FAITHFUL mockup — premium Apple/SaaS aesthetic, system font, subtle shadows, rounded corners.
Rules:
- Recreate ONLY the app/website INTERFACE itself (its screens, cards, panels, graphics). EXCLUDE: any person/face/presenter; AND every creator-added overlay — the burned-in subtitle captions (usually bottom), the big hook/title text banners (e.g. "ChatGPT can do a full color analysis on you"), emoji/sticker overlays. Keep ONLY the genuine in-app content.
- Reproduce the interface faithfully: same layout, same IN-APP texts (verbatim), colors, badges, components, positions. Do NOT invent a different design, and do NOT include the caption/subtitle/hook text.
- The <body> is 360px WIDE, margin 0. Its HEIGHT is whatever the content needs — recreate the COMPLETE interface top to bottom (do NOT crop, cut off, or shrink it to fit a fixed height). It will be shown in a scrollable frame, so a tall body is fine.
- Colors: success green #16a34a, error red #dc2626, warning amber #e0a458.
Return ONLY the HTML, starting with <!doctype html>. No markdown fences, no commentary.`;
  const userContent = imageDataUrl
    ? [
        { type: "text", text: "This is a real frame from the video. Recreate ONLY the app/website interface shown — clean and faithful. EXCLUDE the person, AND the creator's overlay text (the bottom subtitle captions and the big hook banner) and any emoji/stickers. Keep only the genuine in-app UI and its real texts." + (visual ? (" Notes: " + visual) : "") },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ]
    : (context ? "Context: " + context + "\n\n" : "") + "Recreate this UI as a clean mockup (no person, faithful to the description): " + visual;
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "system", content: SYS }, { role: "user", content: userContent }],
    max_completion_tokens: 9000,
    ...reasoningOpts(model),
  });
  let html = (res.choices?.[0]?.message?.content || "").trim();
  html = html.replace(/^```html?\s*/i, "").replace(/```\s*$/i, "").trim();
  return html;
}

export async function storyboard(script) {
  if (!script || !script.trim()) {
    const e = new Error("Paste a script first so I can build the breakdown.");
    e.code = "NO_SCRIPT";
    throw e;
  }
  const client = await getOpenAI();
  const model = process.env.OPENAI_STORYBOARD_MODEL || process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1";
  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYS },
      { role: "user", content: "SKRIPT (mit Zeitstempeln):\n\n" + script },
    ],
    response_format: { type: "json_schema", json_schema: { name: "storyboard", strict: true, schema: SCHEMA } },
    max_completion_tokens: 8000,
  });
  const out = pickJsonFromText(res.choices?.[0]?.message?.content || "{}");
  return { ...out, model, costUsd: cost(model, res.usage) };
}
