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

const isReasoning = (model) => /^(gpt-5|o[0-9])/i.test(model || "");

/** Token budget for a plain (non-JSON) completion. Reasoning models (gpt-5/o) spend
 *  completion tokens on hidden reasoning first, so give them a much larger budget or
 *  the visible output is empty/truncated. We deliberately do NOT set reasoning_effort:
 *  restricted keys / unverified orgs return 401 on it. Spread into create(). */
export function tune(model, outputBudget = 4000) {
  return { max_completion_tokens: isReasoning(model) ? outputBudget + 12000 : outputBudget };
}

/** Robust JSON completion. Prefers Structured Outputs (json_schema) for reliability,
 *  but keys on an UNVERIFIED org get 401 "insufficient permissions" on json_schema
 *  (and on reasoning_effort). On any failure we retry as a PLAIN completion and parse
 *  the JSON out of the text — the messages already ask for the fields. Returns
 *  { data, usage }. Works with restricted keys, full keys, and any model. */
export async function completeJson(client, { model, messages, schema, schemaName = "out", outputBudget = 4000 } = {}) {
  const maxTok = isReasoning(model) ? outputBudget + 12000 : outputBudget;
  try {
    const res = await client.chat.completions.create({
      model, messages,
      response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
      max_completion_tokens: maxTok,
      ...(isReasoning(model) ? { reasoning_effort: "low" } : {}),
    });
    return { data: pickJsonFromText(res.choices?.[0]?.message?.content || "{}"), usage: res.usage };
  } catch {
    const keys = schema && schema.properties ? Object.keys(schema.properties) : [];
    const msgs = messages.concat([{ role: "user", content: "Respond with ONLY a valid JSON object" + (keys.length ? " with keys: " + keys.join(", ") : "") + " — no markdown, no code fences, no commentary." }]);
    const res = await client.chat.completions.create({ model, messages: msgs, max_completion_tokens: maxTok });
    return { data: pickJsonFromText(res.choices?.[0]?.message?.content || "{}"), usage: res.usage };
  }
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
