// Predictive model: regress a reel's content features (+ optional retention/engagement)
// onto log10(views) with ridge regression, and report honest leave-one-out accuracy +
// the standardized coefficients (which levers move views). Pure JS, zero deps.
import { getDb, isConfigured } from "./store/supabase.mjs";
import { viewAdjustments } from "./confound.mjs";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
export { isConfigured };

function transcriptSegments(sc) {
  const p = path.join("analysis", sc + ".json");
  if (!existsSync(p)) return [];
  try { const j = JSON.parse(readFileSync(p, "utf8")); return (j.transcript && j.transcript.segments) || []; } catch { return []; }
}

// ── tiny linear algebra ──────────────────────────────────────────────────────
const T = (A) => A[0].map((_, j) => A.map((r) => r[j]));
const mul = (A, B) => A.map((r) => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
const matVec = (A, x) => A.map((r) => r.reduce((s, v, k) => s + v * x[k], 0));
function inv(M) { // Gauss-Jordan
  const n = M.length, A = M.map((r, i) => [...r, ...r.map((_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    const d = A[c][c] || 1e-9; for (let j = 0; j < 2 * n; j++) A[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j]; }
  }
  return A.map((r) => r.slice(n));
}
function ridge(X, y, lambda) { // beta = (XtX + lambda I)^-1 Xt y   (X already has intercept col)
  const Xt = T(X), XtX = mul(Xt, X), p = XtX.length;
  for (let i = 1; i < p; i++) XtX[i][i] += lambda; // don't penalize intercept
  const Xty = matVec(Xt, y);
  return matVec(inv(XtX), Xty);
}

// ── feature engineering ──────────────────────────────────────────────────────
// REAL data only — measured visuals + DETERMINISTIC script/posting features (regex over
// the transcript + the timestamp; no LLM opinions — those audited up to ~70% wrong).
const CATS = ["length_bucket", "person_presence", "screen_demo_level", "motion_style", "scene_variety", "tool_mentioned", "post_slot"];
const BOOLS = ["has_big_hook_text", "hook_has_question", "hook_has_number", "hook_addresses_viewer", "cta_comment", "is_weekend"];

// Deterministic content features computed from the transcript text itself.
// German ASR writes Claude as "Cloud", so that spelling counts as a Claude mention.
function scriptFeatures(tr, durSec) {
  const t = String(tr || "");
  const head = t.slice(0, 180), tail = t.slice(-300);
  const words = t.trim().split(/\s+/).filter(Boolean).length;
  const tool = /chat\s?gpt/i.test(t) ? "chatgpt" : /\b(claude|cloud)\b/i.test(t) ? "claude" : /gemini/i.test(t) ? "gemini" : "none";
  return {
    feats: {
      tool_mentioned: tool,
      hook_has_question: /\?/.test(head),
      hook_has_number: /\d/.test(head),
      hook_addresses_viewer: /\b(du|dein\w*|dir|dich)\b/i.test(head),
      cta_comment: /komment/i.test(tail),
    },
    pace: durSec ? +(words / durSec).toFixed(2) : 0,
  };
}
function postFeatures(publishedAt) {
  if (!publishedAt) return { post_slot: "unknown", is_weekend: false };
  const d = new Date(publishedAt);
  const h = d.getHours(), dow = d.getDay();
  return { post_slot: h < 12 ? "morning" : h < 18 ? "afternoon" : "evening", is_weekend: dow === 0 || dow === 6 };
}

async function load() {
  const db = await getDb();
  let q = db.from("reels").select("shortcode,duration_sec,transcript_text,caption,published_at,retention_curve,skip_rate,visual_stats,frame_track,reel_metrics(plays,reach,saves,likes,shares,comments,captured_date),reel_features(features)").not("summary", "is", null);
  if (process.env.IG_ACCOUNT) q = q.eq("ig_account", process.env.IG_ACCOUNT);
  const { data } = await q;
  const adj = await viewAdjustments(); // time context: ageDays + maturity (incomplete views)
  const reels = (data || []).map((r) => {
    const m = (r.reel_metrics || []).slice().sort((a, b) => String(b.captured_date).localeCompare(String(a.captured_date)))[0] || {};
    const rf = r.reel_features; const features = rf ? (Array.isArray(rf) ? rf[0] && rf[0].features : rf.features) : null;
    const rc = Array.isArray(r.retention_curve) ? r.retention_curve : null;
    let hook = null, comp = null;
    if (rc && rc.length >= 2) {
      const pairs = (typeof rc[0] === "object") ? rc.map((x) => ({ t: +x.t, p: +x.p })).sort((a, b) => a.t - b.t) : rc.map((p, i, a) => ({ t: i, p: +p }));
      comp = pairs[pairs.length - 1].p; let lo = pairs[0], hi = pairs[pairs.length - 1];
      for (const a of pairs) { if (a.t <= 3) lo = a; if (a.t >= 3) { hi = a; break; } }
      hook = lo.t === hi.t ? lo.p : lo.p + (hi.p - lo.p) * ((3 - lo.t) / (hi.t - lo.t));
    }
    const a = adj.by[r.shortcode] || {};
    const sf = scriptFeatures(r.transcript_text, r.duration_sec);
    const pf = postFeatures(r.published_at);
    const plays = m.plays || 0;
    const rate = (v) => (plays > 0 && v != null ? +((v / plays) * 100).toFixed(3) : 0);
    const dur = r.duration_sec || 0;
    // opening structure, from the measured frame track (all knowable before posting)
    const track = Array.isArray(r.frame_track) ? r.frame_track.map((e) => ({ ...e, t: +e.t })).sort((x, y) => x.t - y.t) : [];
    const isDemo = (e) => e && (e.sc === "screen_demo" || e.sc === "overlay_on_face" || (e.app && e.app !== "none"));
    const firstDemo = track.find(isDemo);
    const firstCut = track.find((e, i) => i > 0 && e.sc !== track[0].sc);
    let cuts = 0; for (let i = 1; i < track.length; i++) if (track[i].sc !== track[i - 1].sc) cuts++;
    const vsCuts = r.visual_stats && r.visual_stats.scene_cuts != null ? r.visual_stats.scene_cuts : cuts;
    // opening narration, from the timestamped transcript
    const segs = transcriptSegments(r.shortcode);
    const speechStart = segs.length ? Math.max(0, segs[0].start || 0) : 0;
    let hookWords3 = 0;
    for (const g of segs) {
      const ov = Math.min(3, g.end || 0) - Math.max(0, g.start || 0);
      if (ov <= 0) continue;
      const w = String(g.text || "").trim().split(/\s+/).filter(Boolean).length;
      hookWords3 += w * (ov / Math.max(0.25, (g.end || 0) - (g.start || 0)));
    }
    // script style + caption
    const t = String(r.transcript_text || ""), head = t.slice(0, 180);
    const wordsAll = t.trim().split(/\s+/).filter(Boolean);
    const duDensity = wordsAll.length ? +(wordsAll.filter((w) => /^(du|dein\w*|dir|dich)$/i.test(w)).length / wordsAll.length * 100).toFixed(2) : 0;
    const cap = String(r.caption || "");
    return { shortcode: r.shortcode, dur, views: plays, reach: m.reach || 0,
      features: features ? { ...features, ...sf.feats, ...pf,
        opens_on_face: !!(track[0] && track[0].p === 1 && track[0].sc === "talking_head"),
        curiosity_template: /was passiert,? wenn/i.test(head),
        says_time_promise: /(sekunden|minuten|stunden|tag(e|en)?)\b/i.test(head),
        caption_has_cta: /komment|folg|link|speicher/i.test(cap),
      } : null,
      pace: sf.pace, skipRate: r.skip_rate || 0,
      timeToDemo: firstDemo ? Math.min(firstDemo.t, dur) : dur,
      timeToCut: firstCut ? Math.min(firstCut.t, dur) : dur,
      avgSceneLen: dur / (vsCuts + 1),
      speechStart, hookWords3: +hookWords3.toFixed(1), duDensity,
      hashtagCount: (cap.match(/#\w+/g) || []).length,
      saveRate: rate(m.saves), shareRate: rate(m.shares), commentRate: rate(m.comments), likeRate: rate(m.likes),
      hook, comp, ageDays: a.ageDays != null ? a.ageDays : 999, mature: a.mature !== false };
  }).filter((r) => r.features && r.views > 0 && r.mature); // drop reels too fresh to have settled views
  return { reels, meta: adj.meta };
}

// Extra PRE-POSTING lever groups (all deterministic; ablated to see which explain views):
// opening = structure of the first seconds, scriptx = script style, caption = post caption.
const GROUP_NUMS = {
  opening: [["time_to_demo", (r) => r.timeToDemo || 0], ["time_to_first_cut", (r) => r.timeToCut || 0], ["avg_scene_len", (r) => r.avgSceneLen || 0], ["speech_start", (r) => r.speechStart || 0], ["hook_words_3s", (r) => r.hookWords3 || 0]],
  scriptx: [["du_density", (r) => r.duDensity || 0]],
  caption: [["hashtag_count", (r) => r.hashtagCount || 0]],
};
const GROUP_BOOLS = { opening: ["opens_on_face"], scriptx: ["curiosity_template", "says_time_promise"], caption: ["caption_has_cta"] };

// Default = "opening" only: the ablation showed scriptx/caption cost out-of-sample
// accuracy at N=41 (0.187 base → 0.151 with all groups = overfit), while opening is
// ~free (0.189) and its levers match the per-second attention model independently.
function designMatrix(reels, { withRetention = false, withEngagement = false, groups = ["opening"] } = {}) {
  // numeric columns per tier, all z-scored so coefficients are genuinely standardized.
  // age_z controls residual maturity among settled reels; the engagement tier is
  // after-the-fact quality (per-view rates) — explanatory, not plannable.
  const NUMS = [["dur_z", (r) => r.dur], ["age_z", (r) => r.ageDays], ["pace_z", (r) => r.pace || 0]];
  for (const g of groups) NUMS.push(...(GROUP_NUMS[g] || []));
  if (withRetention) NUMS.push(["hook_ret", (r) => r.hook || 0], ["completion", (r) => r.comp || 0], ["skip_rate", (r) => r.skipRate || 0]);
  if (withEngagement) NUMS.push(["save_rate", (r) => r.saveRate || 0], ["share_rate", (r) => r.shareRate || 0], ["comment_rate", (r) => r.commentRate || 0], ["like_rate", (r) => r.likeRate || 0]);
  const stats = NUMS.map(([name, get]) => { const vs = reels.map(get); const m = vs.reduce((a, b) => a + b, 0) / vs.length; const sd = Math.sqrt(vs.reduce((s, v) => s + (v - m) ** 2, 0) / vs.length) || 1; return { name, get, m, sd }; });
  const cols = ["_intercept", ...stats.map((s) => s.name)];
  const byName = new Map(stats.map((s) => [s.name, s]));
  for (const c of CATS) { [...new Set(reels.map((r) => String(r.features[c])))].forEach((v) => cols.push(c + "=" + v)); }
  for (const b of [...BOOLS, ...groups.flatMap((g) => GROUP_BOOLS[g] || [])]) cols.push(b);
  const X = reels.map((r) => cols.map((c) => {
    if (c === "_intercept") return 1;
    const st = byName.get(c);
    if (st) return (st.get(r) - st.m) / st.sd;
    if (c.includes("=")) { const [f, v] = c.split("="); return String(r.features[f]) === v ? 1 : 0; }
    return r.features[c] ? 1 : 0;
  }));
  const y = reels.map((r) => Math.log10(r.views + 1));
  return { X, y, cols };
}

const r2 = (yTrue, yPred) => { const m = yTrue.reduce((a, b) => a + b, 0) / yTrue.length; const ss = yTrue.reduce((s, v, i) => s + (v - yPred[i]) ** 2, 0); const tot = yTrue.reduce((s, v) => s + (v - m) ** 2, 0); return tot ? 1 - ss / tot : 0; };

/** Fit + honest leave-one-out CV. Returns accuracy, drivers, and the model. */
export async function trainViewsModel({ withRetention = true, withEngagement = false, groups } = {}) {
  const { reels, meta } = await load();
  if (reels.length < 12) return { n: reels.length, meta, note: "Need more reels with features + views." };
  const { X, y, cols } = designMatrix(reels, { withRetention, withEngagement, ...(groups ? { groups } : {}) });
  // pick lambda by leave-one-out CV over a grid
  const grid = [3, 10, 30, 100, 300];
  let best = { lambda: 30, r2: -Infinity };
  for (const lambda of grid) {
    const pred = [];
    for (let i = 0; i < X.length; i++) {
      const Xtr = X.filter((_, k) => k !== i), ytr = y.filter((_, k) => k !== i);
      const beta = ridge(Xtr, ytr, lambda);
      pred.push(X[i].reduce((s, v, k) => s + v * beta[k], 0));
    }
    const acc = r2(y, pred);
    if (acc > best.r2) best = { lambda, r2: acc };
  }
  // final fit on all data
  const beta = ridge(X, y, best.lambda);
  const inPred = X.map((row) => row.reduce((s, v, k) => s + v * beta[k], 0));
  const drivers = cols.map((c, i) => ({ feature: c, coef: +beta[i].toFixed(3) }))
    .filter((d) => d.feature !== "_intercept" && d.feature !== "age_z").sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef));
  const medErrPct = (() => { const es = y.map((v, i) => Math.abs(10 ** inPred[i] - 10 ** v) / (10 ** v)); es.sort((a, b) => a - b); return Math.round(es[Math.floor(es.length / 2)] * 100); })();
  return { n: reels.length, meta, withRetention, withEngagement, looR2: +best.r2.toFixed(3), inSampleR2: +r2(y, inPred).toFixed(3), lambda: best.lambda, medianErrorPct: medErrPct, drivers: drivers.slice(0, 12), beta, cols };
}
