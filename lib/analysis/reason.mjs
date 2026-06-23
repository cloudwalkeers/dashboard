// Final analysis via an OpenAI reasoning/chat model (default gpt-4.1). Correlates
// the categorized visual timeline + spoken transcript + (optional) real metrics
// into specific, timestamped feedback — on the content's own terms.
import { getOpenAI, pickJsonFromText, cost } from "./client.mjs";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "hook", "dropoff", "suggestions", "moments"],
  properties: {
    summary: { type: "string" },
    hook: { type: "string" },
    dropoff: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["t", "why"],
        properties: { t: { type: "number" }, why: { type: "string" } },
      },
    },
    suggestions: { type: "array", items: { type: "string" } },
    moments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["t", "label"],
        properties: { t: { type: "number" }, label: { type: "string" } },
      },
    },
  },
};

const SYS =
  "You are a short-form-video strategist analyzing ONE Instagram Reel.\n" +
  "CONTEXT — read carefully:\n" +
  "• This is GERMAN-language content made for a German-speaking audience. German is the correct, " +
  "intended language. NEVER suggest translating it, adding English subtitles, or imply that using " +
  "German hurts it. Judge it as German content for Germans.\n" +
  "• The reel HAS spoken narration. The FULL SPOKEN TRANSCRIPT below is the actual audio (transcribed " +
  "by Whisper). The 'written' items in the timeline are text shown ON SCREEN — a SEPARATE channel that " +
  "may or may not match the audio. Use both, and call out where on-screen text reinforces or diverges " +
  "from what's said. The video is NOT silent — never claim it 'lacks audio' or 'relies only on text'.\n" +
  "• You may be given real metrics and an estimated retention curve, or they may be empty. If they are " +
  "empty/unavailable, do NOT invent drop-off percentages or assert where viewers actually left. Give a " +
  "qualitative read instead and frame each 'dropoff' entry as a hypothesis tied to a specific on-screen " +
  "moment (or return an empty list if nothing clearly stands out).\n" +
  "Be specific to THIS topic (loop engineering / agentic coding with Claude). Avoid generic advice.\n" +
  "Fields: summary (2-4 sentences, incl. the editing/animation style); hook (assess the first 3s for " +
  "this audience); dropoff (timestamped friction hypotheses); suggestions (concrete edits a German tech " +
  "creator could realistically make — never 'add English'); moments (notable timestamps to surface).";

export async function runAnalysis({ metrics = {}, retention = [], transcript = { segments: [] }, frames = [], durationSec = 0, model = process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1", dryRun = false } = {}) {
  if (dryRun)
    return {
      result: {
        summary: "(dry-run) no model call made — plumbing only.",
        hook: "(dry-run)",
        dropoff: [],
        suggestions: ["Run without --dry-run (OPENAI_API_KEY set) for the real analysis."],
        moments: [],
      },
      usage: null,
      costUsd: 0,
      model,
    };

  const client = await getOpenAI();
  const timeline =
    frames
      .map((f) => {
        const parts = [`${f.t}s: ${f.visual || "(scene)"}`];
        if (f.motion) parts.push(`motion: ${f.motion}`);
        const written = (f.text || []).map((x) => `"${x.content}" (${x.role})`).join("; ");
        if (written) parts.push(`written: ${written}`);
        return "- " + parts.join(" | ");
      })
      .join("\n") || "(no frames)";
  const hasMetrics = metrics && Object.keys(metrics).length > 0;
  const hasRetention = Array.isArray(retention) && retention.length > 0;

  const user =
    `LENGTH: ${durationSec}s\n` +
    `METRICS: ${hasMetrics ? JSON.stringify(metrics) : "(not provided — do not invent retention numbers)"}\n` +
    `ESTIMATED RETENTION (0=start … 20=end, % still watching): ${hasRetention ? retention.join(", ") : "(not measured)"}\n\n` +
    `TIMELINE (visual | motion | overlay text | spoken caption per frame):\n${timeline}\n\n` +
    `FULL SPOKEN TRANSCRIPT (from the burned-in subtitles):\n${transcript.text || "(none captured)"}`;

  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYS },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: { name: "reel_analysis", strict: true, schema: SCHEMA } },
    max_completion_tokens: 4096,
  });

  return { result: pickJsonFromText(res.choices?.[0]?.message?.content || "{}"), usage: res.usage, costUsd: cost(model, res.usage), model };
}
