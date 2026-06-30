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
