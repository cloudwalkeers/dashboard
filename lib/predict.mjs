// Predictive model: regress a reel's content features (+ optional retention/engagement)
// onto log10(views) with ridge regression, and report honest leave-one-out accuracy +
// the standardized coefficients (which levers move views). Pure JS, zero deps.
import { getDb, isConfigured } from "./store/supabase.mjs";
import { viewAdjustments } from "./confound.mjs";
export { isConfigured };

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
  let q = db.from("reels").select("shortcode,duration_sec,transcript_text,published_at,retention_curve,skip_rate,reel_metrics(plays,reach,saves,likes,shares,comments,captured_date),reel_features(features)").not("summary", "is", null);
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
    return { shortcode: r.shortcode, dur: r.duration_sec || 0, views: plays, reach: m.reach || 0,
      features: features ? { ...features, ...sf.feats, ...pf } : null,
      pace: sf.pace, skipRate: r.skip_rate || 0,
      saveRate: rate(m.saves), shareRate: rate(m.shares), commentRate: rate(m.comments), likeRate: rate(m.likes),
      hook, comp, ageDays: a.ageDays != null ? a.ageDays : 999, mature: a.mature !== false };
  }).filter((r) => r.features && r.views > 0 && r.mature); // drop reels too fresh to have settled views
  return { reels, meta: adj.meta };
}

function designMatrix(reels, { withRetention = false, withEngagement = false } = {}) {
  // numeric columns per tier, all z-scored so coefficients are genuinely standardized.
  // age_z controls residual maturity among settled reels; the engagement tier is
  // after-the-fact quality (per-view rates) — explanatory, not plannable.
  const NUMS = [["dur_z", (r) => r.dur], ["age_z", (r) => r.ageDays], ["pace_z", (r) => r.pace || 0]];
  if (withRetention) NUMS.push(["hook_ret", (r) => r.hook || 0], ["completion", (r) => r.comp || 0], ["skip_rate", (r) => r.skipRate || 0]);
  if (withEngagement) NUMS.push(["save_rate", (r) => r.saveRate || 0], ["share_rate", (r) => r.shareRate || 0], ["comment_rate", (r) => r.commentRate || 0], ["like_rate", (r) => r.likeRate || 0]);
  const stats = NUMS.map(([name, get]) => { const vs = reels.map(get); const m = vs.reduce((a, b) => a + b, 0) / vs.length; const sd = Math.sqrt(vs.reduce((s, v) => s + (v - m) ** 2, 0) / vs.length) || 1; return { name, get, m, sd }; });
  const cols = ["_intercept", ...stats.map((s) => s.name)];
  const byName = new Map(stats.map((s) => [s.name, s]));
  for (const c of CATS) { [...new Set(reels.map((r) => String(r.features[c])))].forEach((v) => cols.push(c + "=" + v)); }
  for (const b of BOOLS) cols.push(b);
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
export async function trainViewsModel({ withRetention = true, withEngagement = false } = {}) {
  const { reels, meta } = await load();
  if (reels.length < 12) return { n: reels.length, meta, note: "Need more reels with features + views." };
  const { X, y, cols } = designMatrix(reels, { withRetention, withEngagement });
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
