// Script -> animation storyboard. Turns a timestamped video script into a
// per-beat visual plan with concise, ready-to-paste prompts for Claude Design
// (an AI design/mockup tool). Built for a German-speaking AI influencer who
// needs UI mockups (Claude/ChatGPT), simple images, or short animations that
// illustrate what the narration is saying.
import { getOpenAI, pickJsonFromText, cost } from "./analysis/client.mjs";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "beats"],
  properties: {
    title: { type: "string" },
    beats: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["time", "narration", "type", "visual", "prompt"],
        properties: {
          time: { type: "string" },
          narration: { type: "string" },
          type: { type: "string", enum: ["ui-animation", "static", "none"] },
          visual: { type: "string" },
          prompt: { type: "string" },
        },
      },
    },
  },
};

const SYS = `Du bist Visual Director für einen deutschsprachigen KI-Influencer, der KI-Use-Cases promotet. Aus einem Skript mit Zeitstempeln baust du ein Storyboard: für JEDEN Beat entscheidest du das beste On-Screen-Visual und schreibst einen kurzen, präzisen Prompt für Claude Design (ein KI-Tool, das UI-Mockups, Bilder und kurze Animationen generiert).

VISUAL-TYPEN:
- "ui-animation": kurze Animation IN einem Tool-Interface (Claude Co-work, ChatGPT …) — z.B. Datei hochladen, Tool analysiert, markiert, zeigt Ergebnis. Nutze das, wenn die Narration einen Vorgang / die Nutzung eines Tools beschreibt.
- "static": EIN sauberes Bild / eine Title-Card, die ein Konzept oder Feature benennt (z.B. wenn ein Feature namentlich vorgestellt wird).
- "none": kein Visual nötig (z.B. Wegwerf-Sätze wie "das kannst du kostenlos ausprobieren").

REGELN:
- Nutze die Zeitstempel des Skripts, um Beats zu definieren; fasse Zeilen, die EIN Visual teilen, zusammen.
- Jeder "prompt" ist auf DEUTSCH, knapp (1-3 Sätze), und beschreibt exakt: welches Interface, welche Aktion Schritt für Schritt, welcher On-Screen-Text, welcher Stil. Bei Animationen: Apple-Style, clean, premium SaaS-UI, 4K, smooth.
- Bei "ui-animation" IMMER das Tool nennen (Claude Co-work / ChatGPT) und die konkreten Schritte (z.B. "Mietvertrag.pdf hochladen → Claude analysiert → markiert Abweichungen rot → fügt Redlines ein → Risk-Summary erscheint rechts").
- Bei "static": kurz das Motiv + Text + Stil.
- Bei "none": "visual" = "—", "prompt" = "".
- Minimalistisch. Kein Fülltext. Nur das Nötigste.
- Wiederkehrende Muster (gleicher Tool-Flow für mehrere Features) dürfen sich in der Struktur ähneln, aber mit dem jeweils korrekten Inhalt.

Gib STRICT JSON nach Schema zurück.`;

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
    max_completion_tokens: 3500,
  });
  const out = pickJsonFromText(res.choices?.[0]?.message?.content || "{}");
  return { ...out, model, costUsd: cost(model, res.usage) };
}
