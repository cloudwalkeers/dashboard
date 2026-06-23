// OpenAI client + helpers. The SDK is imported lazily so the dashboard runs
// with zero dependencies until you actually call the live pipeline.

let _client;

export async function getOpenAI() {
  if (_client) return _client;
  const key = process.env.OPENAI_API_KEY;
  if (!key)
    throw new Error("OPENAI_API_KEY is not set — add it to .env to run the live pipeline (or pass --dry-run).");
  let OpenAI;
  try {
    ({ default: OpenAI } = await import("openai"));
  } catch {
    throw new Error("openai SDK is not installed. Run: npm install");
  }
  _client = new OpenAI({ apiKey: key });
  return _client;
}

/** Parse the JSON object out of a model's text response. */
export function pickJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Model did not return JSON: " + String(text).slice(0, 200));
  }
}

// Rough USD per 1M tokens [input, output] for cost estimates. Unknown models → 0.
const PRICE = {
  "gpt-4o": [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4.1": [2, 8],
  "gpt-4.1-mini": [0.4, 1.6],
};

export function cost(model, usage) {
  if (!usage) return 0;
  const [pi, po] = PRICE[model] || [0, 0];
  return +(((usage.prompt_tokens || 0) * pi + (usage.completion_tokens || 0) * po) / 1e6).toFixed(4);
}
