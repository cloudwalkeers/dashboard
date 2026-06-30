// Script -> animation storyboard, frame by frame, like a pro visual brief.
// Structure is derived ENTIRELY from the script: however many sections the video
// needs, each broken into detailed FRAMES (exact on-screen elements to render in
// Claude Design) plus a scene-by-scene Kling AI animation prompt. Nothing is
// assumed about feature count or layout — it depends on the video.
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
        required: ["label", "time", "subtitle", "narration", "type", "frames", "klingPrompt", "duration", "aspect"],
        properties: {
          label: { type: "string" },
          time: { type: "string" },
          subtitle: { type: "string" },
          narration: { type: "string" },
          type: { type: "string", enum: ["ui-animation", "static", "none"] },
          frames: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["caption", "visual"],
              properties: {
                caption: { type: "string" },
                visual: { type: "string" },
              },
            },
          },
          klingPrompt: { type: "string" },
          duration: { type: "string" },
          aspect: { type: "string" },
        },
      },
    },
  },
};

const SYS = `Du bist Visual Director / Storyboard-Artist für einen deutschsprachigen KI-Influencer. Aus einem Skript mit Zeitstempeln baust du ein DETAILLIERTES Storyboard-Briefing — Frame für Frame — das man 1:1 in Claude Design (UI-Mockups) und Kling AI (Animation) umsetzen kann.

WICHTIG: Die Struktur kommt KOMPLETT aus dem Skript. Zahl der Sektionen, Frames und Typen hängen NUR vom Inhalt dieses Videos ab — nichts ist vorgegeben. Ein anderes Video ergibt ein völlig anderes Storyboard.

Gruppiere das Skript in SEKTIONEN (logische Einheiten / Use-Cases / Schritte). Pro Sektion:
- "label": kurzer Titel (z.B. "1. Contract Reviewer", "Intro", "Installation").
- "time": Zeitbereich aus dem Skript.
- "subtitle": EINE Zeile, was visuell passiert.
- "narration": die zugehörigen Skript-Zeilen.
- "type": "ui-animation" (Flow in einem Interface), "static" (eine Title-Card / ein Bild) oder "none" (kein Visual).
- "frames": die EINZELNEN Frames des Storyboards, in Reihenfolge. Pro Frame:
    - "caption": kurzes deutsches Label (z.B. "1. Dokument hochladen", "3. Abweichungen markiert").
    - "visual": SEHR DETAILLIERTE Beschreibung, was in DIESEM Frame exakt auf dem Bildschirm ist — so präzise, dass Claude Design es direkt rendern kann. Nenne konkret: das Interface (z.B. "Claude Co-work Chat-UI, helles Theme"), die genauen On-Screen-TEXTE auf Deutsch (Nachrichten, Button-Labels, Datei-Namen wie "Mietvertrag.pdf 2.4 MB"), UI-Elemente (Sidebar, Buttons, Badges, Spinner, Fortschrittsbalken), Farben und Status (Ampel: Hohes Risiko rot, Mittleres gelb, Niedriges grün; "Redlines Bereit ✓"), Layout/Position. Wie ein echtes UI-Mockup-Spec, nicht nur ein Stichwort.
  Bei "static": 1 Frame (die Title-Card, detailliert). Bei "none": leeres Array.
- "klingPrompt": ENGLISCHER Kling-AI-Animations-Prompt, Szene für Szene, der GENAU die Frames oben animiert. Format: "Apple style UI animation, smooth and clean. Scene 1: … Scene 2: … Scene 3: … Scene 4: … Smooth camera push-in, slight parallax, 4K, 60fps, premium SaaS UI, no extra elements." Jede Scene = der Übergang/die Bewegung von einem Frame zum nächsten (Upload-Bar 0→100%, Spinner, Highlights/Redlines zeichnen sich Zeile für Zeile, Sidebar slides in von rechts …). Bei "static": einfache Einblend-Animation. Bei "none": "".
- "duration": z.B. "~10 Sek" (passend zur Sektion).
- "aspect": "9:16".

Konkret, präzise, KEIN Geschwafel, keine generischen Floskeln. Lieber konkrete On-Screen-Inhalte als Adjektive. Strict JSON nach Schema.`;

export async function storyboard(script) {
  if (!script || !script.trim()) {
    const e = new Error("Paste a script first so I can build the storyboard.");
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
