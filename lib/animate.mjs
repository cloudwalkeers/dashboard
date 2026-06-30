// Script -> animation breakdown, in the exact format the creator wants: the video
// is split into sections by WHAT HAPPENS (derived entirely from the script), and
// each section gets (a) the German narration line, (b) a detailed English
// directorial animation brief (ASOS-example quality), and (c) the storyboard
// frames as detailed on-screen specs (to render the mockups in Claude Design).
import { getOpenAI, pickJsonFromText, cost } from "./analysis/client.mjs";

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
        required: ["label", "time", "narration", "animation", "mockups"],
        properties: {
          label: { type: "string" },
          time: { type: "string" },
          narration: { type: "string" },
          animation: { type: "string" },
          mockups: {
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
  const SYS = `Du reverse-engineerst die ANIMATIONEN / UI-VISUALS eines bestehenden Reels — also NUR die eingeblendeten Grafiken, App-/Web-Interfaces, Overlays, Diagramme und Mockups. IGNORIERE die sprechende Person / den Talking Head komplett: in deinen Outputs kommt KEIN Mensch, KEIN Gesicht, KEIN Presenter vor — ausschließlich die UI/Grafik. Reine Talking-Head-Momente OHNE eingeblendete Grafik lässt du KOMPLETT WEG.

Input: analysierte FRAMES (Zeit, visual, motion, on-screen text) + TRANSCRIPT.
Teile die Visuals in SEKTIONEN (eine pro UI-/Grafik-Moment / Schritt). Pro Sektion:
- "label": kurzer Titel.
- "time": Zeitbereich (mm:ss–mm:ss).
- "narration": gesprochenes Zitat in dieser Zeit (aus dem Transcript).
- "animation": ENGLISCHER, konkreter Brief NUR der UI-Animation — was sich auf dem Screen aufbaut/bewegt (Overlays, Diagramme, App-Flows, Übergänge), OHNE Person.
- "mockups": 2–4 KEY-Frames der UI als SAUBERE Mockup-Beschreibungen (NUR UI/Grafik, KEINE Person, KEIN Gesicht). Pro Mockup: "caption" (kurz, deutsch) und "visual" (sehr konkret: welches Interface/welche Grafik, exakte On-Screen-Texte, Farben, Layout — so dass man es 1:1 als sauberes, eigenständiges Mockup rendern kann, OHNE Mensch).
Strict JSON nach Schema.`;
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "system", content: SYS }, { role: "user", content: "FRAMES:\n" + frameLines + "\n\nTRANSCRIPT:\n" + transLines }],
    response_format: { type: "json_schema", json_schema: { name: "reel_breakdown", strict: true, schema: REEL_SCHEMA } },
    max_completion_tokens: 6000,
  });
  const out = pickJsonFromText(res.choices?.[0]?.message?.content || "{}");
  const sections = (out.sections || []).map((sec) => ({
    label: sec.label, time: sec.time || "", narration: sec.narration || "", animation: sec.animation || "",
    frames: (sec.mockups || []).map((m) => ({ caption: m.caption || "", visual: m.visual || "" })),
  }));
  return { title: out.title || "Reel animation breakdown", sections, model, costUsd: cost(model, res.usage) };
}

// Render ONE frame's visual description as a self-contained HTML phone mockup,
// so the dashboard can show an actual picture (in an iframe) — not just text.
export async function renderFrame(visual, { context = "" } = {}) {
  if (!visual || !visual.trim()) {
    const e = new Error("No frame description to render.");
    e.code = "NO_VISUAL";
    throw e;
  }
  const client = await getOpenAI();
  const model = process.env.OPENAI_RENDER_MODEL || process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1";
  const SYS = `You are a senior product designer. Output ONE self-contained HTML document (inline CSS only, NO external assets, NO JavaScript) that renders the described UI/graphic as a clean, realistic mockup — premium Apple/SaaS aesthetic: white UI, system font (-apple-system, Segoe UI, sans-serif), subtle shadows, rounded corners, generous spacing.
Rules:
- Render ONLY the interface / graphic / app screen. NEVER draw a person, face, presenter, talking head, or photo of a human — only the UI. If the description mentions a presenter, ignore that part.
- The <body> is EXACTLY 360x640px (9:16), margin 0, overflow hidden — everything fits, no scrollbars.
- If it's an app or website, draw a realistic mobile status bar at top (time e.g. 16:50, signal, wifi, battery).
- Use the EXACT on-screen texts, labels, product names, prices (e.g. "€89,00"), codes, and states from the description. Colors: success green #16a34a, error red #dc2626, warning amber #e0a458, primary action dark/black or brand color.
- Make it look designed and real, like a storyboard frame — not a wireframe.
Return ONLY the HTML, starting with <!doctype html>. No markdown fences, no commentary.`;
  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYS },
      { role: "user", content: (context ? "Context: " + context + "\n\n" : "") + "Frame to render: " + visual },
    ],
    max_completion_tokens: 2600,
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
