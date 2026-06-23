// Per-frame analysis via an OpenAI vision model (default gpt-4.1). Each frame is
// broken into separate, comparable categories:
//   visual — the scene (people, setting, framing)
//   motion — animation / movement / transition vs the previous frame
//   text   — every distinct piece of WRITTEN on-screen text, each with detailed
//            typography (content, role, font, color, background, size, position)
// Written text is NOT assumed to equal the spoken audio (that comes from Whisper).
// Batched so coarse OR fine sampling stays within one request's image budget.
import { readFile } from "node:fs/promises";
import { getOpenAI, pickJsonFromText, cost } from "./client.mjs";

const TEXT_ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["content", "role", "font", "color", "background", "size", "position"],
  properties: {
    content: { type: "string" },
    role: { type: "string" },
    font: { type: "string" },
    color: { type: "string" },
    background: { type: "string" },
    size: { type: "string" },
    position: { type: "string" },
  },
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["frames"],
  properties: {
    frames: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["visual", "motion", "text"],
        properties: {
          visual: { type: "string" },
          motion: { type: "string" },
          text: { type: "array", items: TEXT_ITEM },
        },
      },
    },
  },
};

const BATCH = 24;

function prompt(n, caption) {
  return (
    `Below are ${n} frames sampled in chronological order from an Instagram Reel` +
    (caption ? ` captioned "${caption}"` : "") +
    ` — German content for a German-speaking audience. For each frame, in order, return three ` +
    `SEPARATE fields:\n` +
    `- "visual": the scene only — people, setting, framing, what is shown. Do NOT put text content here.\n` +
    `- "motion": movement/animation/transition vs the previous frame (a gesture, a cut, an overlay ` +
    `appearing/switching, a zoom). "" if it looks static.\n` +
    `- "text": an array of EVERY distinct piece of written text visible in the frame — subtitles, titles, ` +
    `diagram labels, tweets, UI text. The written text is NOT necessarily what is being spoken; report ` +
    `only what is actually written. For each element give, in detail:\n` +
    `    • "content": the text, verbatim, keeping German exactly as shown\n` +
    `    • "role": subtitle | title | headline | diagram-label | tweet | ui | watermark | other\n` +
    `    • "font": best-guess family + weight/style (e.g. "bold sans-serif", "rounded grotesque", "monospace")\n` +
    `    • "color": the text colour (name or hex-ish, e.g. "white", "bright yellow #FFD400", "red")\n` +
    `    • "background": what is behind it (e.g. "black rounded box", "white card", "none / over video")\n` +
    `    • "size": relative size (e.g. "large headline", "medium", "small caption")\n` +
    `    • "position": location in frame (e.g. "bottom center", "top third", "upper-left card")\n` +
    `  Use an empty array if the frame has no written text.`
  );
}

export async function describeFrames(frames, { dryRun = false, model = process.env.OPENAI_VISION_MODEL || "gpt-4.1", caption = "", onStep = () => {} } = {}) {
  if (dryRun)
    return {
      items: frames.map((f) => ({ t: f.t, visual: `(dry-run) frame at ${f.t}s`, motion: "", text: [] })),
      usage: null,
      costUsd: 0,
      model,
    };

  const client = await getOpenAI();
  const items = [];
  let pin = 0;
  let pout = 0;

  const batches = Math.ceil(frames.length / BATCH);
  for (let b = 0; b < frames.length; b += BATCH) {
    onStep("vision " + (b / BATCH + 1) + "/" + batches);
    const chunk = frames.slice(b, b + BATCH);
    const content = [{ type: "text", text: prompt(chunk.length, caption) }];
    for (const f of chunk) {
      content.push({ type: "text", text: `Frame ${f.t}s:` });
      const b64 = (await readFile(f.file)).toString("base64");
      content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } });
    }
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content }],
      response_format: { type: "json_schema", json_schema: { name: "frame_analysis", strict: true, schema: SCHEMA } },
      max_completion_tokens: 12000,
    });
    const arr = (pickJsonFromText(res.choices?.[0]?.message?.content || "{}").frames) || [];
    chunk.forEach((f, i) =>
      items.push({ t: f.t, visual: arr[i]?.visual || "", motion: arr[i]?.motion || "", text: Array.isArray(arr[i]?.text) ? arr[i].text : [] })
    );
    pin += res.usage?.prompt_tokens || 0;
    pout += res.usage?.completion_tokens || 0;
  }

  const usage = { prompt_tokens: pin, completion_tokens: pout };
  return { items, usage, costUsd: cost(model, usage), model };
}
