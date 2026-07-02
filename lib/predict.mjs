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
// REAL data only — same measured whitelist as the causal ledger. No LLM opinions (they
// were up to ~70% wrong vs the frames, and correlated guesses like hook_type/hook_has_number
// produce contradictory, unstable coefficients at this sample size).
const CATS = ["length_bucket", "person_presence", "screen_demo_level", "motion_style", "scene_variety", "caption_style"];
const BOOLS = ["has_big_hook_text"];

async function load() {
  const db = await getDb();
  let q = db.from("reels").select("shortcode,duration_sec,retention_curve,skip_rate,reel_metrics(plays,reach,saves,likes,shares,captured_date),reel_features(features)").not("summary", "is", null);
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
    return { shortcode: r.shortcode, dur: r.duration_sec || 0, views: m.plays || 0, reach: m.reach || 0, features, hook, comp, ageDays: a.ageDays != null ? a.ageDays : 999, mature: a.mature !== false };
  }).filter((r) => r.features && r.views > 0 && r.mature); // drop reels too fresh to have settled views
  return { reels, meta: adj.meta };
}

function designMatrix(reels, { withRetention = false } = {}) {
  // build the column vocabulary
  const cols = ["_intercept", "dur_z", "age_z"];
  const catVals = {};
  for (const c of CATS) { catVals[c] = [...new Set(reels.map((r) => String(r.features[c])))]; catVals[c].forEach((v) => cols.push(c + "=" + v)); }
  for (const b of BOOLS) cols.push(b);
  if (withRetention) cols.push("hook_ret", "completion");
  // standardize duration + reel age (age_z controls for residual maturity among settled reels)
  const durs = reels.map((r) => r.dur); const dMean = durs.reduce((a, b) => a + b, 0) / durs.length;
  const dSd = Math.sqrt(durs.reduce((s, v) => s + (v - dMean) ** 2, 0) / durs.length) || 1;
  const ages = reels.map((r) => r.ageDays); const aMean = ages.reduce((a, b) => a + b, 0) / ages.length;
  const aSd = Math.sqrt(ages.reduce((s, v) => s + (v - aMean) ** 2, 0) / ages.length) || 1;
  const X = reels.map((r) => cols.map((c) => {
    if (c === "_intercept") return 1;
    if (c === "dur_z") return (r.dur - dMean) / dSd;
    if (c === "age_z") return (r.ageDays - aMean) / aSd;
    if (c === "hook_ret") return (r.hook || 0) / 100;
    if (c === "completion") return (r.comp || 0) / 100;
    if (c.includes("=")) { const [f, v] = c.split("="); return String(r.features[f]) === v ? 1 : 0; }
    return r.features[c] ? 1 : 0;
  }));
  const y = reels.map((r) => Math.log10(r.views + 1));
  return { X, y, cols, dMean, dSd };
}

const r2 = (yTrue, yPred) => { const m = yTrue.reduce((a, b) => a + b, 0) / yTrue.length; const ss = yTrue.reduce((s, v, i) => s + (v - yPred[i]) ** 2, 0); const tot = yTrue.reduce((s, v) => s + (v - m) ** 2, 0); return tot ? 1 - ss / tot : 0; };

/** Fit + honest leave-one-out CV. Returns accuracy, drivers, and the model. */
export async function trainViewsModel({ withRetention = true } = {}) {
  const { reels, meta } = await load();
  if (reels.length < 12) return { n: reels.length, meta, note: "Need more reels with features + views." };
  const { X, y, cols } = designMatrix(reels, { withRetention });
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
  return { n: reels.length, meta, withRetention, looR2: +best.r2.toFixed(3), inSampleR2: +r2(y, inPred).toFixed(3), lambda: best.lambda, medianErrorPct: medErrPct, drivers: drivers.slice(0, 12), beta, cols };
}
