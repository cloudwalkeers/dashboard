// Script -> animation storyboard, in the style of a pro visual brief: grouped by
// SECTION (one per feature / logical unit, not per micro-beat). Each section gets
// the UI-mockup storyboard steps + a detailed Claude Design prompt (to render the
// mockup) AND a scene-by-scene Kling AI animation prompt (to animate it), with
// duration + aspect — matching the creator's reference layout.
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
        required: ["label", "time", "subtitle", "narration", "type", "steps", "designPrompt", "klingPrompt", "duration", "aspect"],
        properties: {
          label: { type: "string" },
          time: { type: "string" },
          subtitle: { type: "string" },
          narration: { type: "string" },
          type: { type: "string", enum: ["ui-animation", "static", "none"] },
          steps: { type: "array", items: { type: "string" } },
          designPrompt: { type: "string" },
          klingPrompt: { type: "string" },
          duration: { type: "string" },
          aspect: { type: "string" },
        },
      },
    },
  },
};

const SYS = `Du bist Visual Director für einen deutschsprachigen KI-Influencer, der KI-Use-Cases promotet. Aus einem Skript mit Zeitstempeln baust du ein professionelles STORYBOARD-BRIEFING, gruppiert nach SEKTIONEN — eine Sektion pro Feature / logischer Einheit (NICHT pro Mini-Satz). Typisch: ein Intro, je Feature/Use-Case eine Sektion, eine Installations-/CTA-Sektion, Wegwerf-Sätze als "none".

Pro Sektion lieferst du EXAKT:
- "label": kurzer Titel, nummeriert wo sinnvoll (z.B. "1. Contract Reviewer", "Intro", "Installation").
- "time": Zeitbereich aus dem Skript (z.B. "0:31 – 0:41").
- "subtitle": EINE Zeile, was visuell passiert (z.B. "Vertrag hochladen, Abweichungen, Risiken & Redlines").
- "narration": die zugehörigen Skript-Zeilen, zusammengefasst.
- "type": "ui-animation" (Flow in einem Tool-Interface), "static" (eine Title-Card / ein Bild) oder "none" (kein Visual nötig).
- "steps": 3–4 kurze deutsche Frame-Captions des Storyboards (z.B. "1. Dokument hochladen", "2. Analyse läuft", "3. Abweichungen markiert", "4. Risiko & Redlines erstellt"). Bei "static" 1 Eintrag, bei "none" leeres Array.
- "designPrompt": DEUTSCHER Prompt für Claude Design, der das UI-Mockup-Storyboard rendert. Beschreibe konkret: welches Interface (Claude Co-work / ChatGPT), das Dokument, was in JEDEM Frame zu sehen ist (Upload → Analyse/Spinner → Markierungen → Ergebnis/Sidebar), Ampelfarben (rot/gelb/grün) für Risiko, premium SaaS-UI, Apple-Style, clean, hell. Konzis, kein Fülltext.
- "klingPrompt": ENGLISCHER Kling-AI-Animations-Prompt, Szene für Szene wie ein Profi-Briefing. Format genau so: "Apple style UI animation, smooth and clean. Scene 1: … Scene 2: … Scene 3: … Scene 4: … Smooth camera push-in, slight parallax, 4K, 60fps, premium SaaS UI, no extra elements." Jede Scene = EIN konkreter Animationsschritt (z.B. cursor drags PDF in, upload bar 0→100%; loading spinner; highlights/redlines draw in line by line; right sidebar with risk summary slides in).
- "duration": z.B. "~10 Sek" (passend zur Skript-Zeit der Sektion).
- "aspect": "9:16" (Reel).

Bei "static": designPrompt = kurze Title-Card-Beschreibung (Motiv, Text, Stil), klingPrompt = einfache Einblend-Animation (Logo/Text fade-in + subtle pop, soft scale-up), duration ~3 Sek.
Bei "none": steps=[], designPrompt="", klingPrompt="", duration="", aspect="".

Konkret, präzise, kein Geschwafel. Gib STRICT JSON nach Schema zurück.`;

export async function storyboard(script) {
  if (!script || !script.trim()) {
    const e = new Error("Paste a script first so I can build the storyboard.");
    e.code = "NO_SCRIPT";
    throw e;
  }
  const client = await getOpenAI();
  const model = process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1";
  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYS },
      { role: "user", content: "SKRIPT (mit Zeitstempeln):\n\n" + script },
    ],
    response_format: { type: "json_schema", json_schema: { name: "storyboard", strict: true, schema: SCHEMA } },
    max_completion_tokens: 6000,
  });
  const out = pickJsonFromText(res.choices?.[0]?.message?.content || "{}");
  return { ...out, model, costUsd: cost(model, res.usage) };
}
