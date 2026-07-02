// Causal engine (honest version): turn each reel into structured content
// features, then for every feature CONTRAST reels that have it vs reels that
// don't — winners AND losers — with a real statistical test. Most patterns
// correctly come back "inconclusive" at small N; the ledger sharpens as data
// grows. This never claims causation it doesn't have; it generates hypotheses
// and quantifies how much (little) the data currently supports them.
import { getOpenAI, pickJsonFromText, cost } from "./analysis/client.mjs";
import { getDb, isConfigured } from "./store/supabase.mjs";
import { bucketFeatures } from "./analysis/visualStats.mjs";

export { isConfigured };

// ── feature extraction ──────────────────────────────────────────────────────
// gpt-5 / o-series burn max_completion_tokens on hidden reasoning; cap it. No-op on gpt-4.x.
function reasoningOpts(model) { return /^(gpt-5|o[0-9])/i.test(model || "") ? { reasoning_effort: "low" } : {}; }

const ENUMS = {
  // ── hook taxonomy (expanded) ──
  hook_type: [
    "question", "claim_promise", "number_stat", "story", "shock", "how_to",
    "curiosity_gap", "controversy", "warning", "result_teaser", "contrarian",
    "relatable_problem", "other",
  ],
  hook_promise: [
    "secret_or_trick", "step_by_step_guide", "tool_recommendation", "result_or_proof",
    "warning_or_mistake", "opinion_or_take", "none",
  ],
  hook_specificity: ["vague", "specific", "hyper_specific"],
  hook_length: ["one_liner", "short", "medium", "long"], // by word count of the first spoken line
  hook_emotion: ["curiosity", "shock", "fomo", "excitement", "practical", "other"],
  length_bucket: ["short_lt20", "mid_20_40", "long_gt40"],
  format: ["talking_head", "screencast_demo", "mixed", "text_overlay", "other"],
  // ── content: coarse topic + a more informative subject ──
  topic: ["ai_tools", "productivity", "news_trend", "tutorial_howto", "opinion_take", "other"],
  subject: [
    "ai_coding", "ai_agents_automation", "ai_image_video", "ai_writing_content",
    "prompting_technique", "ai_tool_review", "ai_news_trend", "ai_business_money",
    "job_career", "finance_investing", "fitness_health", "productivity_systems",
    "personal_brand_growth", "education_learning", "other",
  ],
  cta_type: ["comment_magnet", "follow", "save", "link", "none"],
  cta_position: ["none", "early", "middle", "end"],
  pace_of_speech: ["slow", "measured", "fast"],
  // design / motion — classified from the actual on-screen frames
  text_overlay_density: ["none", "light", "heavy"],
  visual_pace: ["slow", "medium", "fast"],
  opens_energy: ["static", "some_motion", "high_motion"], // first ~3s visual energy
  talking_head_share: ["none", "some", "dominant"],
};
const FEATURE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: [
    "hook_type", "hook_promise", "hook_specificity", "hook_addresses_viewer",
    "opens_on_face", "hook_has_number", "length_bucket", "format", "topic", "subject", "cta_type",
    "step_by_step", "shows_result_early", "high_visual_intensity",
    "uses_screen_demo", "has_ui_animation", "text_overlay_density", "visual_pace",
    "has_diagram_or_data", "talking_head_share", "hook_emotion", "names_specific_tool", "benefit_driven",
    "hook_length", "cta_position", "pace_of_speech", "opens_energy", "delivers_payoff", "has_burned_captions",
  ],
  properties: {
    hook_type: { type: "string", enum: ENUMS.hook_type },
    hook_promise: { type: "string", enum: ENUMS.hook_promise },
    hook_specificity: { type: "string", enum: ENUMS.hook_specificity },
    hook_addresses_viewer: { type: "boolean" },
    opens_on_face: { type: "boolean" },
    hook_has_number: { type: "boolean" },
    length_bucket: { type: "string", enum: ENUMS.length_bucket },
    format: { type: "string", enum: ENUMS.format },
    topic: { type: "string", enum: ENUMS.topic },
    subject: { type: "string", enum: ENUMS.subject },
    cta_type: { type: "string", enum: ENUMS.cta_type },
    step_by_step: { type: "boolean" },
    shows_result_early: { type: "boolean" },
    high_visual_intensity: { type: "boolean" },
    // design / motion (grounded in the frames)
    uses_screen_demo: { type: "boolean" },
    has_ui_animation: { type: "boolean" },
    text_overlay_density: { type: "string", enum: ENUMS.text_overlay_density },
    visual_pace: { type: "string", enum: ENUMS.visual_pace },
    has_diagram_or_data: { type: "boolean" },
    talking_head_share: { type: "string", enum: ENUMS.talking_head_share },
    hook_emotion: { type: "string", enum: ENUMS.hook_emotion },
    names_specific_tool: { type: "boolean" },
    benefit_driven: { type: "boolean" },
    hook_length: { type: "string", enum: ENUMS.hook_length },
    cta_position: { type: "string", enum: ENUMS.cta_position },
    pace_of_speech: { type: "string", enum: ENUMS.pace_of_speech },
    opens_energy: { type: "string", enum: ENUMS.opens_energy },
    delivers_payoff: { type: "boolean" },
    has_burned_captions: { type: "boolean" },
  },
};

async function extractOne(client, model, reel) {
  const tr = reel.transcript || "";
  const trShown = tr.length > 1500 ? (tr.slice(0, 800) + " […] " + tr.slice(-600)) : tr; // keep the OUTRO — CTAs live there, not in the first 400 chars
  const content = `Classify this Instagram Reel into structured CONTENT + DESIGN/MOTION features (describe what's there, don't judge quality).
LENGTH: ${reel.durationSec ?? "?"}s
HOOK (first spoken line): ${reel.hook || "(none)"}
SUMMARY: ${reel.summary || ""}
FULL TRANSCRIPT (the CTA is almost always in the LAST 1-2 sentences): ${trShown}
ON-SCREEN VISUAL TRACK (sampled frames — what is actually shown & animated over time): ${reel.visualTrack || "(not available)"}

Base the DESIGN/MOTION features (uses_screen_demo, has_ui_animation, text_overlay_density, visual_pace, has_diagram_or_data, talking_head_share, high_visual_intensity) on the VISUAL TRACK — not on guesses. If the visual track is unavailable, infer conservatively from the format/summary.
Base the HOOK features (hook_type, hook_promise, hook_specificity, hook_addresses_viewer, hook_emotion, hook_has_number, opens_on_face) ONLY on the first spoken line and the first ~3 seconds. For "subject" pick the most specific informative category that fits (e.g. ai_coding or prompting_technique rather than the generic topic) — it should tell a human what the reel is actually about.
For "hook_length" count the words in the FIRST spoken line: one_liner (≤4 words), short (5–9), medium (10–16), long (17+).
Ground these on the VISUAL TRACK: "opens_energy" = motion in the first ~3s of frames (static / some_motion / high_motion); "has_burned_captions" = on-screen subtitle text present. "delivers_payoff" = does the video actually deliver what the hook promised (true) or is it bait (false). "cta_position" = where the call-to-action lands in the transcript (early/middle/end/none). "pace_of_speech" = rough speaking speed inferred from transcript length over the video duration.
CTA (cta_type) — read the WHOLE transcript, ESPECIALLY the ending (the CTA is nearly always the last sentence, in German): "kommentiere/kommentier/schreib(e) X in die Kommentare" or "comment X" → comment_magnet; "folg mir"/"follow" → follow; "speicher(e)"/"save" → save; "link in bio / in der Bio" → link; a genuine absence of any ask → none. If BOTH a follow and a comment prompt appear (typical outro like "folg mir und kommentiere X"), classify cta_type as comment_magnet (the primary mechanism). Set cta_position to where it lands (usually "end").`;
  const res = await client.chat.completions.create({
    model, messages: [{ role: "user", content }],
    response_format: { type: "json_schema", json_schema: { name: "reel_features", strict: true, schema: FEATURE_SCHEMA } },
    max_completion_tokens: 700,
    ...reasoningOpts(model),
  });
  return { features: pickJsonFromText(res.choices?.[0]?.message?.content || "{}"), usage: res.usage };
}

async function loadReels({ withVisuals = false } = {}) {
  const db = await getDb();
  const sel = "id,shortcode,summary,hook,transcript_text,duration_sec,retention_curve,skip_rate,visual_stats,reel_metrics(likes,comments,plays,reach,saves,shares,avg_watch_sec,captured_date),reel_features(features)" + (withVisuals ? ",reel_frames(visual,motion,t)" : "");
  let q = db.from("reels").select(sel).not("summary", "is", null);
  if (process.env.IG_ACCOUNT) q = q.eq("ig_account", process.env.IG_ACCOUNT);
  const { data, error } = await q;
  if (error) throw new Error("causal load: " + error.message);
  const mapped = (data || []).map((r) => {
    const m = (r.reel_metrics || []).slice().sort((a, b) => String(b.captured_date).localeCompare(String(a.captured_date)))[0] || {};
    const rf = r.reel_features; // one-to-one (reel_id PK) -> object, not array
    const features = rf ? (Array.isArray(rf) ? (rf[0] && rf[0].features) : rf.features) : null;
    const likes = m.likes ?? null, plays = m.plays ?? null;
    const saves = m.saves ?? null, shares = m.shares ?? null, reach = m.reach ?? null;
    const avgWatch = m.avg_watch_sec ?? null;
    const dur = r.duration_sec ? Math.round(r.duration_sec) : null;
    const base = plays || reach || null;                 // fairest denominator: views, else reach
    const pct = (v) => (base && v != null ? +((v / base) * 100).toFixed(3) : null);
    // Real audience retention (from insights recordings), when we have the curve.
    const rc = Array.isArray(r.retention_curve) ? r.retention_curve : null;
    let hook_retention = null, completion = null, retPairs = null;
    if (rc && rc.length >= 2) {
      const pairs = (typeof rc[0] === "object" && rc[0] != null)
        ? rc.map((x) => ({ t: +x.t, p: +x.p })).sort((a, b) => a.t - b.t)
        : rc.map((p, i, a) => ({ t: (dur || 1) * i / (a.length - 1), p: +p }));
      retPairs = pairs;
      completion = pairs[pairs.length - 1].p;
      let lo = pairs[0], hi = pairs[pairs.length - 1];
      for (const a of pairs) { if (a.t <= 3) lo = a; if (a.t >= 3) { hi = a; break; } }
      hook_retention = Math.round(lo.t === hi.t ? lo.p : lo.p + (hi.p - lo.p) * ((3 - lo.t) / (hi.t - lo.t))); // % at 3s
    }
    // Compact on-screen visual track (sampled frames) to ground the design/motion features.
    let visualTrack = null;
    if (withVisuals && Array.isArray(r.reel_frames) && r.reel_frames.length) {
      const fr = r.reel_frames.slice().sort((a, b) => Number(a.t) - Number(b.t));
      const step = Math.max(1, Math.floor(fr.length / 12));
      visualTrack = fr.filter((_, i) => i % step === 0).slice(0, 12)
        .map((f) => `${Math.round(f.t)}s: ${(f.visual || "").slice(0, 220)}${f.motion ? ` [motion: ${String(f.motion).slice(0, 60)}]` : ""}`)
        .join("\n").slice(0, 3000);
    }
    return {
      id: r.id, shortcode: r.shortcode,
      summary: r.summary || "", hook: r.hook || "", transcript: r.transcript_text || "",
      durationSec: dur,
      likes, comments: m.comments ?? null, plays, saves, shares, reach, avgWatch,
      // de-confounded RATE outcomes (control for reach/views); raw counts kept too
      rate: pct(likes),          // like rate
      save_rate: pct(saves),     // saves ÷ views — the strongest "this was actually good" signal
      share_rate: pct(shares),   // shares ÷ views
      watch_through: dur && avgWatch ? +((avgWatch / dur) * 100).toFixed(2) : null, // % of the reel watched
      hook_retention, completion, // real 3s hold + end retention (from insights recordings)
      retPairs, // full per-second retention curve ({t,p}[]) for granular analysis
      skip_rate: r.skip_rate ?? null, // % who swiped away (real, from insights)
      stay_rate: r.skip_rate != null ? +(100 - r.skip_rate).toFixed(2) : null, // higher = fewer skips
      features: features || null,
      visual_stats: r.visual_stats || null,
      visualTrack,
    };
  });

  // Lab only analyzes reels with real traction: exclude anything below the view
  // floor (default 800 views; a reel with unknown views can't clear it). "views"
  // is the `plays` field. Override with LAB_MIN_VIEWS.
  const MIN_VIEWS = Number(process.env.LAB_MIN_VIEWS || 800);
  return mapped.filter((r) => (r.plays ?? 0) >= MIN_VIEWS);
}

/** Extract + store features for any reels missing them. */
export async function buildFeatures({ force = false } = {}) {
  const db = await getDb();
  const reels = await loadReels({ withVisuals: true });
  const todo = reels.filter((r) => force || !r.features);
  if (!todo.length) return { extracted: 0, total: reels.length };
  const client = await getOpenAI();
  const model = process.env.OPENAI_FEATURE_MODEL || "gpt-4.1"; // classification: fast + cheap, no reasoning needed
  let costUsd = 0;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  for (const r of todo) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const { features, usage } = await extractOne(client, model, r);
        costUsd += cost(model, usage);
        // merge measured visual buckets (person_presence, screen_demo_level, …) from visual_stats
        const merged = r.visual_stats ? { ...features, ...bucketFeatures(r.visual_stats) } : features;
        await db.from("reel_features").upsert({ reel_id: r.id, shortcode: r.shortcode, features: merged, extracted_at: new Date().toISOString() }, { onConflict: "reel_id" });
        break;
      } catch (e) {
        if (String(e && e.message).includes("429")) { await sleep(5000); continue; } // rate limit → back off
        throw e;
      }
    }
    await sleep(2500); // stay under the 30k TPM cap so `force` re-classification completes in one pass
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
  return { n: reels.length, losers: losers.length, withViews: reels.filter((r) => r.plays != null).length, hypotheses: rows };
}

// ── human-readable feature labels + experiment designer ──────────────────────
const LABELS = {
  hook_type: { number_stat: "a number/stat in the hook", question: "a question hook", claim_promise: "a bold claim/promise hook", story: "a story hook", shock: "a shock hook", how_to: "a how-to hook", curiosity_gap: "a curiosity-gap hook", controversy: "a controversial hook", warning: "a warning hook", result_teaser: "a result-teaser hook", contrarian: "a contrarian hook", relatable_problem: "a relatable-problem hook", other: "a generic hook" },
  hook_promise: { secret_or_trick: "a hook promising a secret/trick", step_by_step_guide: "a hook promising a step-by-step guide", tool_recommendation: "a hook recommending a tool", result_or_proof: "a hook showing a result/proof", warning_or_mistake: "a hook warning about a mistake", opinion_or_take: "a hook leading with an opinion", none: "a hook with no clear promise" },
  hook_specificity: { vague: "a vague hook", specific: "a specific hook", hyper_specific: "a hyper-specific hook" },
  subject: { ai_coding: "AI coding", ai_agents_automation: "AI agents/automation", ai_image_video: "AI image/video", ai_writing_content: "AI writing/content", prompting_technique: "a prompting technique", ai_tool_review: "an AI tool review", ai_news_trend: "AI news/trend", ai_business_money: "AI for business/money", job_career: "jobs/career", finance_investing: "finance/investing", fitness_health: "fitness/health", productivity_systems: "productivity systems", personal_brand_growth: "personal brand/growth", education_learning: "education/learning", other: "another subject" },
  hook_length: { one_liner: "a one-line hook (≤4 words)", short: "a short hook (5–9 words)", medium: "a medium hook (10–16 words)", long: "a long hook (17+ words)" },
  cta_position: { none: "no CTA", early: "a CTA early", middle: "a CTA mid-video", end: "a CTA at the end" },
  pace_of_speech: { slow: "a slow speaking pace", measured: "a measured speaking pace", fast: "a fast speaking pace" },
  opens_energy: { static: "a static opening", some_motion: "some opening motion", high_motion: "a high-energy opening" },
  length_bucket: { short_lt20: "under 20s", mid_20_40: "20–40s long", long_gt40: "over 40s long" },
  format: { talking_head: "talking-head only", screencast_demo: "screencast/demo", mixed: "talking-head + screencast", text_overlay: "text-overlay style", other: "other format" },
  topic: { ai_tools: "an AI-tools topic", productivity: "a productivity topic", news_trend: "a news/trend topic", tutorial_howto: "a tutorial/how-to topic", opinion_take: "an opinion/take topic", other: "an other topic" },
  cta_type: { comment_magnet: 'a "comment X" CTA', save: "a save CTA", follow: "a follow CTA", link: "a link CTA", none: "no CTA" },
  text_overlay_density: { none: "no text overlays", light: "light text overlays", heavy: "heavy text overlays" },
  visual_pace: { slow: "a slow visual pace", medium: "a medium visual pace", fast: "a fast visual pace" },
  talking_head_share: { none: "no talking-head", some: "some talking-head", dominant: "mostly talking-head" },
  hook_emotion: { curiosity: "a curiosity hook", shock: "a shock-emotion hook", fomo: "a FOMO hook", excitement: "an excitement hook", practical: "a practical hook", other: "a neutral-emotion hook" },
  hook_addresses_viewer: 'a hook that speaks directly to the viewer ("du/you")', opens_on_face: "opening on your face", hook_has_number: "a number in the hook", step_by_step: "step-by-step structure", shows_result_early: "the result shown in the first 5s", high_visual_intensity: "high visual intensity",
  uses_screen_demo: "an on-screen app/tool demo", has_ui_animation: "animated UI/graphics", has_diagram_or_data: "a diagram/data on screen", names_specific_tool: "a specific tool named", benefit_driven: "a clear benefit/outcome promised", delivers_payoff: "a video that delivers on its hook", has_burned_captions: "burned-in captions/subtitles",
  person_presence: { mostly_screen: "the creator mostly off-camera (screen-heavy)", balanced: "a balanced person/screen mix", mostly_person: "mostly the creator on camera" },
  screen_demo_level: { none: "no screen demo", some: "some screen demo", heavy: "a heavy screen demo" },
  scene_variety: { low: "few scene cuts", medium: "a medium number of cuts", high: "many scene cuts" },
  motion_style: { static: "a static visual style", dynamic: "a dynamic/animated visual style" },
  caption_style: { no_captions: "no subtitle captions", some_captions: "some subtitle captions", full_captions: "full subtitle captions" },
  has_big_hook_text: "a big hook-text banner up front",
  primary_app: { chatgpt: "ChatGPT on screen", claude: "Claude on screen", gemini: "Gemini on screen", calendar: "a calendar on screen", code_editor: "a code editor on screen", browser: "a browser on screen", spreadsheet: "a spreadsheet on screen", phone_ui: "a phone UI on screen", none: "no app shown", other: "another app on screen" },
};
export function humanFeature(feature, value) {
  const m = LABELS[feature];
  if (m && typeof m === "object") return m[value] || `${feature}=${value}`;
  if (typeof m === "string") return value === "true" ? m : "no " + m;
  return `${feature}=${value}`;
}

/** Pick the highest-value UNCERTAIN lever and design a clean A/B for it. The
 *  best test is a big apparent effect we don't yet trust (small n / low conf) —
 *  including "significant" results on tiny samples, which need confirming most. */
export function designExperiment(hypotheses) {
  const cand = (hypotheses || [])
    .filter((h) => Math.abs(h.effect) >= 0.3 && (h.confidence < 0.7 || h.n_with < 6) && h.effect > 0)
    .map((h) => ({ ...h, score: Math.abs(h.effect) * (1 - h.confidence) }))
    .sort((a, b) => b.score - a.score);
  const top = cand[0];
  if (!top) return null;
  const human = humanFeature(top.feature, top.value);
  const dir = top.effect > 0 ? "higher" : "lower";
  return {
    hypothesisId: top.id, feature: top.feature, value: top.value, effect: top.effect, n: top.n_with, confidence: top.confidence,
    claim: `Reels with ${human} look like they get ${dir} engagement rate (effect ${top.effect > 0 ? "+" : ""}${top.effect}) — but on only ${top.n_with} example${top.n_with === 1 ? "" : "s"}, so it's a hunch, not a fact.`,
    instruction: `Post 4 reels on similar topics & length, varying ONLY this: 2 WITH ${human}, 2 WITHOUT. Keep everything else as close as you can. When the views come in, the ledger updates — and we'll actually know.`,
    arms: { test: `2 reels WITH ${human}`, control: `2 reels WITHOUT ${human}` },
    controlFor: ["topic", "length"],
  };
}

/** Ledger + the next experiment, for the Lab UI and to ground Studio. */
export async function insights({ outcome = "rate" } = {}) {
  const a = await analyze({ outcome });
  const hypotheses = (a.hypotheses || []).map((h) => ({ ...h, label: humanFeature(h.feature, h.value) }));
  return { ...a, hypotheses, outcome, experiment: designExperiment(a.hypotheses) };
}

const OUTCOME_LABEL = {
  rate: "like rate (likes ÷ views)",
  save_rate: "save rate (saves ÷ views)",
  share_rate: "share rate (shares ÷ views)",
  watch_through: "watch-through (% of the reel watched)",
  stay_rate: "stay rate (100 − skip rate; higher = fewer swipe-aways)",
  hook_retention: "3s hook retention (% still watching at 3s)",
  completion: "completion (% who watched to the end)",
  likes: "raw likes",
};

/** Plain-language interpretation of the ledger (gpt-5.5): what to act on, what to
 *  ignore, one next move. Honest about small samples. */
export async function interpret({ outcome = "rate" } = {}) {
  const a = await analyze({ outcome });
  const hyps = (a.hypotheses || []).filter((h) => Math.abs(h.effect) >= 0.05);
  if (a.n < 6 || !hyps.length) return { text: "", n: a.n, outcome };
  const client = await getOpenAI();
  const model = process.env.OPENAI_STUDIO_MODEL || process.env.OPENAI_STORYBOARD_MODEL || "gpt-5.5";
  const OUT = OUTCOME_LABEL[outcome] || outcome;
  const lines = hyps.slice(0, 24).map((h) =>
    `- ${humanFeature(h.feature, h.value)}: effect ${h.effect > 0 ? "+" : ""}${h.effect} · ${h.status} · ${Math.round(h.confidence * 100)}% conf · n ${h.n_with}/${h.n_without} · median ${h.median_with} vs ${h.median_without}${h.shared_by_losers ? " · ALSO common in flops" : ""}`);
  const SYS = `You are a sharp growth analyst for a German-speaking AI creator's Instagram reels. You get the output of a causal CONTRAST analysis for the outcome "${OUT}". Each line is a content/design feature: "effect" is rank-biserial (-1..1; POSITIVE = the feature goes with HIGHER ${OUT}), with a status (supported/weak/inconclusive), a confidence, sample sizes (n_with/n_without), medians, and a flag if it is ALSO common in the flops (means it's probably not a real edge).
Write a tight interpretation for the creator — NOT a data dump:
1. **Act on** — the 2-3 findings that are supported / higher-confidence, POSITIVE, and NOT flagged as common-in-flops.
2. **Ignore** — patterns that are inconclusive, tiny-n, or flagged.
3. **Next move** — one concrete action tied to the strongest finding.
Be honest that most of this is small-sample and correlational. Plain language, specific, ~120-160 words. Plain text only — NO markdown symbols like ** or ##; use the three labels "Act on:", "Ignore:", "Next move:" on their own lines and "- " for bullets.`;
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "system", content: SYS }, { role: "user", content: `Outcome: ${OUT}\nReels analyzed: ${a.n} (bottom third counts as flops)\n\n${lines.join("\n")}` }],
    max_completion_tokens: 1400,
    ...reasoningOpts(model),
  });
  return { text: (res.choices?.[0]?.message?.content || "").trim(), n: a.n, outcome, model, costUsd: cost(model, res.usage) };
}

/** The reels that HAVE a given feature value — for the "show me the reels" popup. */
export async function reelsForFeature({ feature, value, outcome = "rate" } = {}) {
  const all = await loadReels();
  const matched = all.filter((r) => r.features && String(r.features[feature]) === String(value));
  const reels = matched.map((r) => ({
    shortcode: r.shortcode,
    label: (r.hook || r.summary || r.shortcode).slice(0, 100),
    hook: (r.hook || "").slice(0, 180),          // the actual first spoken line
    summary: (r.summary || "").slice(0, 220),    // what the reel is about
    outcomeVal: r[outcome] != null ? r[outcome] : null,
    plays: r.plays, reach: r.reach, saves: r.saves,
    watch: r.watch_through, completion: r.completion, // % watched / % to the end
    skipRate: r.skip_rate, likeRate: r.rate, saveRate: r.save_rate, // real per-reel context
    permalink: "https://www.instagram.com/reel/" + r.shortcode + "/",
  })).sort((x, y) => (y.outcomeVal ?? -1) - (x.outcomeVal ?? -1));
  try {
    const { localThumbs } = await import("./store/stored.mjs");
    const thumbs = await localThumbs(reels.map((r) => r.shortcode));
    reels.forEach((r) => { r.thumb = thumbs[r.shortcode] || null; });
  } catch { /* thumbs optional */ }
  return { feature, value, label: humanFeature(feature, value), outcome, reels, n: reels.length };
}

// ── granular retention engine ────────────────────────────────────────────────
// Uses the REAL per-second curves ({t,p}[]) to show, for every content/design
// feature, how reels WITH it hold vs WITHOUT — at 3s (hook), across the whole
// video, and where the biggest drop happens — with a significance test.
const _mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const _r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

function pAtSec(pairs, sec) { // retention % at an absolute second (linear interp)
  if (!pairs || !pairs.length) return null;
  if (sec <= pairs[0].t) return pairs[0].p;
  if (sec >= pairs[pairs.length - 1].t) return pairs[pairs.length - 1].p;
  let lo = pairs[0], hi = pairs[pairs.length - 1];
  for (const pt of pairs) { if (pt.t <= sec) lo = pt; if (pt.t >= sec) { hi = pt; break; } }
  return lo.t === hi.t ? lo.p : lo.p + (hi.p - lo.p) * ((sec - lo.t) / (hi.t - lo.t));
}
function resampleNorm(pairs, N = 21) { // resample to N points over 0..100% of duration
  if (!pairs || pairs.length < 2) return null;
  const tMax = pairs[pairs.length - 1].t || 1;
  const out = [];
  for (let i = 0; i < N; i++) {
    const tt = (i / (N - 1)) * tMax;
    let lo = pairs[0], hi = pairs[pairs.length - 1];
    for (const pt of pairs) { if (pt.t <= tt) lo = pt; if (pt.t >= tt) { hi = pt; break; } }
    out.push(+(lo.t === hi.t ? lo.p : lo.p + (hi.p - lo.p) * ((tt - lo.t) / (hi.t - lo.t))).toFixed(1));
  }
  return out;
}
function avgCurves(curves) {
  const v = curves.filter(Boolean);
  if (!v.length) return null;
  const N = v[0].length, out = new Array(N).fill(0);
  for (const c of v) for (let i = 0; i < N; i++) out[i] += c[i];
  return out.map((x) => +(x / v.length).toFixed(1));
}
function biggestDrop(curve) { // biggest BODY drop (after the universal 0-15% hook drop) = where they leave mid-video
  if (!curve || curve.length < 3) return { atPct: null, loss: 0 };
  const from = Math.max(1, Math.ceil(curve.length * 0.15)); // skip the hook zone every reel shares
  let maxLoss = 0, at = from;
  for (let i = from; i < curve.length; i++) { const loss = curve[i - 1] - curve[i]; if (loss > maxLoss) { maxLoss = loss; at = i; } }
  return { atPct: Math.round((at / (curve.length - 1)) * 100), loss: +maxLoss.toFixed(1) };
}

/** For every feature value, contrast the real retention of reels WITH it vs
 *  WITHOUT — 3s hook hold, completion, drop location, and significance. Ranked
 *  by hook impact. This is the "why do people drop / keep watching" engine. */
export async function retentionInsights({ minN = 3, N = 21 } = {}) {
  const reels = (await loadReels()).filter((r) => r.features && Array.isArray(r.retPairs) && r.retPairs.length >= 2);
  if (reels.length < 6) return { n: reels.length, note: "Need ~6 reels with features + a real retention curve.", rows: [], buckets: [], overall: null };
  for (const r of reels) {
    r._norm = resampleNorm(r.retPairs, N);
    r._p3 = pAtSec(r.retPairs, 3);   // hook hold at 3s
    r._end = r.retPairs[r.retPairs.length - 1].p; // completion
  }
  const overall = avgCurves(reels.map((r) => r._norm));
  const dims = Object.keys(reels[0].features);
  const rows = [];
  for (const dim of dims) {
    for (const value of new Set(reels.map((r) => String(r.features[dim])))) {
      const A = reels.filter((r) => String(r.features[dim]) === value);
      const B = reels.filter((r) => String(r.features[dim]) !== value);
      if (Math.min(A.length, B.length) < minN) continue;
      const curveWith = avgCurves(A.map((r) => r._norm));
      const p3With = _mean(A.map((r) => r._p3)), p3Without = _mean(B.map((r) => r._p3));
      const endWith = _mean(A.map((r) => r._end)), endWithout = _mean(B.map((r) => r._end));
      const drop = biggestDrop(curveWith);
      const mwHook = mannWhitney(A.map((r) => r._p3).filter((x) => x != null), B.map((r) => r._p3).filter((x) => x != null));
      const mwEnd = mannWhitney(A.map((r) => r._end), B.map((r) => r._end));
      rows.push({
        feature: dim, value, label: humanFeature(dim, value), n: A.length,
        hold3s_with: _r1(p3With), hold3s_without: _r1(p3Without), hold3s_delta: _r1(p3With - p3Without),
        completion_with: _r1(endWith), completion_without: _r1(endWithout), completion_delta: _r1(endWith - endWithout),
        biggest_drop_at_pct: drop.atPct, biggest_drop_loss: drop.loss,
        hook_effect: mwHook ? mwHook.effect : null, hook_p: mwHook ? mwHook.p : null,
        completion_effect: mwEnd ? mwEnd.effect : null, completion_p: mwEnd ? mwEnd.p : null,
        curve_with: curveWith, examples: A.slice(0, 4).map((r) => r.shortcode),
      });
    }
  }
  rows.sort((a, b) => Math.abs(b.hold3s_delta) - Math.abs(a.hold3s_delta) || Math.abs(b.completion_delta) - Math.abs(a.completion_delta));
  const buckets = Array.from({ length: N }, (_, i) => Math.round((i / (N - 1)) * 100));
  return { n: reels.length, buckets, overall, rows };
}
