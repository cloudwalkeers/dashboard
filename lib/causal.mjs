// Causal engine (honest version): turn each reel into structured content
// features, then for every feature CONTRAST reels that have it vs reels that
// don't — winners AND losers — with a real statistical test. Most patterns
// correctly come back "inconclusive" at small N; the ledger sharpens as data
// grows. This never claims causation it doesn't have; it generates hypotheses
// and quantifies how much (little) the data currently supports them.
import { getOpenAI, pickJsonFromText, cost } from "./analysis/client.mjs";
import { getDb, isConfigured } from "./store/supabase.mjs";

export { isConfigured };

// ── feature extraction ──────────────────────────────────────────────────────
const ENUMS = {
  hook_type: ["question", "claim_promise", "number_stat", "story", "shock", "how_to", "other"],
  length_bucket: ["short_lt20", "mid_20_40", "long_gt40"],
  format: ["talking_head", "screencast_demo", "mixed", "text_overlay", "other"],
  topic: ["ai_tools", "productivity", "news_trend", "tutorial_howto", "opinion_take", "other"],
  cta_type: ["comment_magnet", "follow", "save", "link", "none"],
};
const FEATURE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["hook_type", "opens_on_face", "hook_has_number", "length_bucket", "format", "topic", "cta_type", "step_by_step", "shows_result_early", "high_visual_intensity"],
  properties: {
    hook_type: { type: "string", enum: ENUMS.hook_type },
    opens_on_face: { type: "boolean" },
    hook_has_number: { type: "boolean" },
    length_bucket: { type: "string", enum: ENUMS.length_bucket },
    format: { type: "string", enum: ENUMS.format },
    topic: { type: "string", enum: ENUMS.topic },
    cta_type: { type: "string", enum: ENUMS.cta_type },
    step_by_step: { type: "boolean" },
    shows_result_early: { type: "boolean" },
    high_visual_intensity: { type: "boolean" },
  },
};

async function extractOne(client, model, reel) {
  const content = `Classify this Instagram Reel into the structured content features (no opinion on quality).
LENGTH: ${reel.durationSec ?? "?"}s
HOOK (first spoken line): ${reel.hook || "(none)"}
SUMMARY: ${reel.summary || ""}
TRANSCRIPT (start): ${(reel.transcript || "").slice(0, 400)}`;
  const res = await client.chat.completions.create({
    model, messages: [{ role: "user", content }],
    response_format: { type: "json_schema", json_schema: { name: "reel_features", strict: true, schema: FEATURE_SCHEMA } },
    max_completion_tokens: 300,
  });
  return { features: pickJsonFromText(res.choices?.[0]?.message?.content || "{}"), usage: res.usage };
}

async function loadReels() {
  const db = await getDb();
  const { data, error } = await db
    .from("reels")
    .select("id,shortcode,summary,hook,transcript_text,duration_sec,reel_metrics(likes,comments,plays,captured_date),reel_features(features)")
    .not("summary", "is", null);
  if (error) throw new Error("causal load: " + error.message);
  return (data || []).map((r) => {
    const m = (r.reel_metrics || []).slice().sort((a, b) => String(b.captured_date).localeCompare(String(a.captured_date)))[0] || {};
    const rf = r.reel_features; // one-to-one (reel_id PK) -> object, not array
    const features = rf ? (Array.isArray(rf) ? (rf[0] && rf[0].features) : rf.features) : null;
    const likes = m.likes ?? null, plays = m.plays ?? null;
    return {
      id: r.id, shortcode: r.shortcode,
      summary: r.summary || "", hook: r.hook || "", transcript: r.transcript_text || "",
      durationSec: r.duration_sec ? Math.round(r.duration_sec) : null,
      likes, comments: m.comments ?? null, plays,
      // engagement RATE — the de-confounded outcome (controls for reach) when views known
      rate: plays && likes != null ? +(likes / plays * 100).toFixed(3) : null,
      features: features || null,
    };
  });
}

/** Extract + store features for any reels missing them. */
export async function buildFeatures({ force = false } = {}) {
  const db = await getDb();
  const reels = await loadReels();
  const todo = reels.filter((r) => force || !r.features);
  if (!todo.length) return { extracted: 0, total: reels.length };
  const client = await getOpenAI();
  const model = process.env.OPENAI_ANALYSIS_MODEL || "gpt-4.1";
  let costUsd = 0;
  for (const r of todo) {
    const { features, usage } = await extractOne(client, model, r);
    costUsd += cost(model, usage);
    await db.from("reel_features").upsert({ reel_id: r.id, shortcode: r.shortcode, features, extracted_at: new Date().toISOString() }, { onConflict: "reel_id" });
  }
  return { extracted: todo.length, total: reels.length, costUsd: +costUsd.toFixed(4) };
}

// ── statistics (Mann–Whitney U, rank-biserial, normal-approx p) ──────────────
function normCdf(z) { // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
function mannWhitney(a, b) {
  const na = a.length, nb = b.length;
  if (!na || !nb) return null;
  const all = a.map((v) => [v, "a"]).concat(b.map((v) => [v, "b"])).sort((x, y) => x[0] - y[0]);
  const ranks = new Array(all.length);
  for (let i = 0; i < all.length;) { // average ranks for ties
    let j = i; while (j < all.length && all[j][0] === all[i][0]) j++;
    const r = (i + j + 1) / 2;
    for (let k = i; k < j; k++) ranks[k] = r;
    i = j;
  }
  let Ra = 0; all.forEach((x, i) => { if (x[1] === "a") Ra += ranks[i]; });
  const Ua = Ra - (na * (na + 1)) / 2;            // # pairs where a>b (+0.5 ties)
  const f = Ua / (na * nb);                         // common-language effect
  const effect = 2 * f - 1;                          // rank-biserial [-1,1]
  const meanU = (na * nb) / 2;
  const sigma = Math.sqrt((na * nb * (na + nb + 1)) / 12) || 1;
  const z = (Ua - meanU) / sigma;
  const p = 2 * (1 - normCdf(Math.abs(z)));
  return { effect: +effect.toFixed(3), p: +p.toFixed(3), na, nb };
}
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

/** Contrast every feature value against the rest; write the hypothesis ledger. */
export async function analyze({ outcome = "likes" } = {}) {
  const db = await getDb();
  const reels = (await loadReels()).filter((r) => r.features && r[outcome] != null);
  if (reels.length < 6) return { n: reels.length, hypotheses: [], note: "Need at least ~6 reels with features + an outcome." };

  const vals = reels.map((r) => r[outcome]).sort((a, b) => a - b);
  const loCut = vals[Math.floor(vals.length / 3)];                 // bottom third = "losers"
  const losers = reels.filter((r) => r[outcome] <= loCut);

  const dims = Object.keys(reels[0].features);
  const rows = [];
  for (const dim of dims) {
    const present = new Set(reels.map((r) => String(r.features[dim])));
    for (const value of present) {
      const A = reels.filter((r) => String(r.features[dim]) === value);
      const B = reels.filter((r) => String(r.features[dim]) !== value);
      if (Math.min(A.length, B.length) < 3) continue;             // too small to say anything
      const mw = mannWhitney(A.map((r) => r[outcome]), B.map((r) => r[outcome]));
      const mWith = median(A.map((r) => r[outcome]));
      const mWithout = median(B.map((r) => r[outcome]));
      const sharedByLosers = losers.length ? losers.filter((r) => String(r.features[dim]) === value).length / losers.length >= 0.34 : false;
      const confidence = +Math.max(0, Math.min(1, (1 - mw.p) * Math.min(1, Math.min(A.length, B.length) / 8))).toFixed(2);
      const status = mw.p < 0.05 && Math.abs(mw.effect) > 0.3 ? "supported"
        : mw.p < 0.2 ? "weak" : "inconclusive";
      rows.push({
        id: `${outcome}::${dim}=${value}`, outcome, feature: dim, value,
        n_with: A.length, n_without: B.length,
        median_with: mWith, median_without: mWithout,
        lift: mWithout ? +(mWith / mWithout).toFixed(2) : null,
        effect: mw.effect, p_value: mw.p, confidence,
        shared_by_losers: sharedByLosers, status,
        updated_at: new Date().toISOString(),
        evidence: { examples: A.slice(0, 4).map((r) => r.shortcode) },
      });
    }
  }
  rows.sort((a, b) => (b.confidence - a.confidence) || (Math.abs(b.effect) - Math.abs(a.effect)));
  if (rows.length) await db.from("hypotheses").upsert(rows, { onConflict: "id" });
  return { n: reels.length, losers: losers.length, hypotheses: rows };
}
