// The attention model — real ML at the right unit of analysis.
// A reel-level model has N≈46 and can only produce artifacts. But the deep data is
// per-SECOND: exact retention (hand-entered) × structured frame track (scene/app/person/
// action) × timestamped transcript ≈ 2,400 observations. This trains gradient-boosted
// trees to predict the per-second HAZARD (fraction of current viewers lost that second)
// from what is on screen and said at that moment, cross-validated by REEL (no reel is in
// both train and test), with a position-only baseline so "content matters" is proven
// against time-decay alone, not assumed. Pure JS, deterministic, zero deps.
import { getDb, isConfigured } from "./store/supabase.mjs";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
export { isConfigured };

// ── per-second dataset assembly ──────────────────────────────────────────────
function perSecond(rc, dur) {
  const pairs = rc.map((x) => (typeof x === "object" ? { t: +x.t, p: +x.p } : null)).filter(Boolean).sort((a, b) => a.t - b.t);
  if (pairs.length < 3) return null;
  const D = Math.round(Math.min(dur || 1e9, pairs[pairs.length - 1].t));
  const out = [];
  for (let s = 0; s <= D; s++) {
    let lo = pairs[0], hi = pairs[pairs.length - 1];
    for (const a of pairs) { if (a.t <= s) lo = a; if (a.t >= s) { hi = a; break; } }
    out.push(lo.t === hi.t ? lo.p : lo.p + (hi.p - lo.p) * ((s - lo.t) / (hi.t - lo.t)));
  }
  return out;
}
function transcriptSegments(sc) {
  const p = path.join("analysis", sc + ".json");
  if (!existsSync(p)) return [];
  try { const j = JSON.parse(readFileSync(p, "utf8")); return (j.transcript && j.transcript.segments) || []; } catch { return []; }
}
const SCENES = ["talking_head", "screen_demo", "overlay_on_face", "animation", "text_card", "b_roll"];
const ACTIONS = ["typing", "scrolling", "transition", "speaking"];
// position features first — the baseline model uses exactly these
export const POSITION_FEATS = ["sec", "pos_frac", "early3", "dur"];
export const CONTENT_FEATS = [
  "person_visible", "cut_now", "sec_since_cut", "app_on_screen", "big_text", "caption",
  ...SCENES.map((s) => "scene_" + s), ...ACTIONS.map((a) => "act_" + a),
  "speech_wps", "is_question", "says_du", "says_number", "silence",
];
export const FEATS = [...POSITION_FEATS, ...CONTENT_FEATS];

export async function buildDataset() {
  const db = await getDb();
  let q = db.from("reels").select("shortcode,duration_sec,retention_curve,frame_track").not("retention_curve", "is", null).not("frame_track", "is", null);
  if (process.env.IG_ACCOUNT) q = q.eq("ig_account", process.env.IG_ACCOUNT);
  const { data } = await q;
  const rows = [], meta = [];
  for (const r of data || []) {
    const dur = Math.round(r.duration_sec || 0);
    const ps = perSecond(Array.isArray(r.retention_curve) ? r.retention_curve : [], dur);
    const track = (Array.isArray(r.frame_track) ? r.frame_track : []).map((e) => ({ ...e, t: +e.t })).sort((a, b) => a.t - b.t);
    if (!ps || ps.length < 10 || track.length < 3) continue;
    const segs = transcriptSegments(r.shortcode);
    const at = (s) => track.reduce((b, e) => (Math.abs(e.t - s) < Math.abs(b.t - s) ? e : b), track[0]);
    for (let s = 1; s < ps.length; s++) {
      const prev = ps[s - 1], cur = ps[s];
      if (prev <= 1) break;
      const hazard = Math.min(0.5, Math.max(0, (prev - cur) / prev)); // fraction of remaining viewers lost this second
      const e = at(s), ePrev = at(Math.max(0, s - 2));
      const cutNow = e !== ePrev && e.sc !== ePrev.sc ? 1 : 0;
      // seconds since the current scene started (walk the track back through same-scene entries)
      let i0 = track.indexOf(e); while (i0 > 0 && track[i0 - 1].sc === e.sc) i0--;
      const secSinceCut = Math.max(0, s - track[i0].t);
      // what is being said in [s, s+1)
      let wps = 0, isQ = 0, du = 0, num = 0;
      for (const g of segs) {
        const a = Math.max(s, g.start || 0), b = Math.min(s + 1, g.end || 0);
        if (b <= a) continue;
        const words = String(g.text || "").trim().split(/\s+/).filter(Boolean).length;
        const span = Math.max(0.25, (g.end || 0) - (g.start || 0));
        wps += words * ((b - a) / span);
        if (/\?/.test(g.text || "")) isQ = 1;
        if (/\b(du|dein\w*|dir|dich)\b/i.test(g.text || "")) du = 1;
        if (/\d/.test(g.text || "")) num = 1;
      }
      const f = {
        sec: s, pos_frac: s / Math.max(1, ps.length - 1), early3: s <= 3 ? 1 : 0, dur,
        person_visible: e.p ? 1 : 0, cut_now: cutNow, sec_since_cut: secSinceCut,
        app_on_screen: e.app && e.app !== "none" ? 1 : 0, big_text: e.big ? 1 : 0, caption: e.cap ? 1 : 0,
        speech_wps: +wps.toFixed(2), is_question: isQ, says_du: du, says_number: num, silence: wps < 0.5 ? 1 : 0,
      };
      for (const sc of SCENES) f["scene_" + sc] = e.sc === sc ? 1 : 0;
      for (const a of ACTIONS) f["act_" + a] = e.a === a ? 1 : 0;
      rows.push(FEATS.map((k) => f[k]));
      meta.push({ shortcode: r.shortcode, sec: s, hazard });
    }
  }
  return { X: rows, y: meta.map((m) => m.hazard), meta, feats: FEATS, nReels: new Set(meta.map((m) => m.shortcode)).size };
}

// ── gradient-boosted regression trees (histogram-based, depth 2) ─────────────
const mulberry = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

function binColumns(X, nBins = 32) {
  const p = X[0].length, edges = [];
  const Xb = X.map(() => new Uint8Array(p));
  for (let j = 0; j < p; j++) {
    const vals = [...new Set(X.map((r) => r[j]))].sort((a, b) => a - b);
    let ed;
    if (vals.length <= nBins) ed = vals.slice(1);
    else ed = Array.from({ length: nBins - 1 }, (_, k) => vals[Math.floor(((k + 1) / nBins) * vals.length)]);
    ed = [...new Set(ed)];
    edges.push(ed);
    for (let i = 0; i < X.length; i++) {
      let b = 0; while (b < ed.length && X[i][j] >= ed[b]) b++;
      Xb[i][j] = b;
    }
  }
  return { Xb, edges };
}

function buildTree(Xb, resid, idx, featIdx, depth, minLeaf, gains) {
  let sum = 0; for (const i of idx) sum += resid[i];
  const node = { leaf: sum / idx.length };
  if (depth === 0 || idx.length < 2 * minLeaf) return node;
  let best = null;
  for (const j of featIdx) {
    const sums = new Float64Array(33), cnts = new Float64Array(33);
    for (const i of idx) { const b = Xb[i][j]; sums[b] += resid[i]; cnts[b] += 1; }
    let ls = 0, ln = 0;
    for (let b = 0; b < 32; b++) {
      ls += sums[b]; ln += cnts[b];
      const rn = idx.length - ln;
      if (ln < minLeaf || rn < minLeaf) continue;
      const rs = sum - ls;
      const gain = (ls * ls) / ln + (rs * rs) / rn - (sum * sum) / idx.length;
      if (gain > 1e-12 && (!best || gain > best.gain)) best = { j, b, gain };
    }
  }
  if (!best) return node;
  gains[best.j] = (gains[best.j] || 0) + best.gain;
  const L = [], R = [];
  for (const i of idx) (Xb[i][best.j] <= best.b ? L : R).push(i);
  node.j = best.j; node.b = best.b;
  node.L = buildTree(Xb, resid, L, featIdx, depth - 1, minLeaf, gains);
  node.R = buildTree(Xb, resid, R, featIdx, depth - 1, minLeaf, gains);
  return node;
}
const treePred = (n, row) => (n.j === undefined ? n.leaf : treePred(row[n.j] <= n.b ? n.L : n.R, row));

export function gbmFit(Xb, y, featIdx, { trees = 120, lr = 0.08, depth = 2, minLeaf = 40, subsample = 0.85, seed = 7 } = {}) {
  const rand = mulberry(seed);
  const base = y.reduce((a, b) => a + b, 0) / y.length;
  const F = new Float64Array(y.length).fill(base);
  const resid = new Float64Array(y.length);
  const models = [], gains = {};
  for (let t = 0; t < trees; t++) {
    const idx = [];
    for (let i = 0; i < y.length; i++) if (rand() < subsample) idx.push(i);
    for (let i = 0; i < y.length; i++) resid[i] = y[i] - F[i];
    const tree = buildTree(Xb, resid, idx, featIdx, depth, minLeaf, gains);
    models.push(tree);
    for (let i = 0; i < y.length; i++) F[i] += lr * treePred(tree, Xb[i]);
  }
  return { base, models, lr, gains, predict: (row) => models.reduce((s, m) => s + lr * treePred(m, row), base) };
}

const r2 = (y, p) => { const m = y.reduce((a, b) => a + b, 0) / y.length; let ss = 0, tot = 0; for (let i = 0; i < y.length; i++) { ss += (y[i] - p[i]) ** 2; tot += (y[i] - m) ** 2; } return tot ? 1 - ss / tot : 0; };

// ── honest evaluation: group K-fold BY REEL + position-only baseline ─────────
export async function trainAttentionModel({ folds = 8 } = {}) {
  const ds = await buildDataset();
  if (ds.X.length < 300) return { nReels: ds.nReels, nSeconds: ds.X.length, note: "Not enough per-second data yet." };
  const { Xb } = binColumns(ds.X);
  const posIdx = POSITION_FEATS.map((f) => FEATS.indexOf(f));
  const allIdx = FEATS.map((_, i) => i);

  const reelList = [...new Set(ds.meta.map((m) => m.shortcode))].sort();
  const foldOf = new Map(reelList.map((sc, i) => [sc, i % folds]));
  const predFull = new Float64Array(ds.y.length), predPos = new Float64Array(ds.y.length);
  for (let k = 0; k < folds; k++) {
    const tr = [], te = [];
    ds.meta.forEach((m, i) => (foldOf.get(m.shortcode) === k ? te : tr).push(i));
    if (!te.length) continue;
    const yTr = tr.map((i) => ds.y[i]);
    const XbTr = tr.map((i) => Xb[i]);
    const mFull = gbmFit(XbTr, yTr, allIdx);
    const mPos = gbmFit(XbTr, yTr, posIdx);
    for (const i of te) { predFull[i] = mFull.predict(Xb[i]); predPos[i] = mPos.predict(Xb[i]); }
  }
  const cvFull = +r2(ds.y, [...predFull]).toFixed(3);
  const cvPos = +r2(ds.y, [...predPos]).toFixed(3);

  // final fit on everything → importance + direction (partial dependence: force the
  // feature to its low vs high bin across the whole dataset, compare mean prediction)
  const final = gbmFit(Xb, ds.y, allIdx);
  const totGain = Object.values(final.gains).reduce((a, b) => a + b, 0) || 1;
  const drivers = Object.entries(final.gains).map(([j, g]) => {
    j = +j;
    const maxBin = Math.max(...Xb.map((r) => r[j]));
    let lo = 0, hi = 0;
    const step = Math.max(1, Math.floor(Xb.length / 400)); // sample for speed
    let n = 0;
    for (let i = 0; i < Xb.length; i += step) {
      const row = Uint8Array.from(Xb[i]);
      row[j] = 0; lo += final.predict(row);
      row[j] = maxBin; hi += final.predict(row);
      n++;
    }
    const effect = (hi - lo) / n; // + = raises drop risk, − = holds attention
    return { feature: FEATS[j], importancePct: +((g / totGain) * 100).toFixed(1), effectPp: +(effect * 100).toFixed(2) };
  }).sort((a, b) => b.importancePct - a.importancePct);

  // per-reel residual diagnosis: which reels bled more/less than their content predicts
  const byReel = {};
  ds.meta.forEach((m, i) => {
    (byReel[m.shortcode] ||= { excess: 0, n: 0 });
    byReel[m.shortcode].excess += ds.y[i] - predFull[i];
    byReel[m.shortcode].n++;
  });
  const reelResiduals = Object.entries(byReel).map(([sc, v]) => ({ shortcode: sc, avgExcessHazardPp: +((v.excess / v.n) * 100).toFixed(2) })).sort((a, b) => b.avgExcessHazardPp - a.avgExcessHazardPp);

  return {
    nReels: ds.nReels, nSeconds: ds.X.length, folds,
    cv: { full: cvFull, positionOnly: cvPos, contentLift: +(cvFull - cvPos).toFixed(3) },
    avgHazardPct: +((ds.y.reduce((a, b) => a + b, 0) / ds.y.length) * 100).toFixed(2),
    drivers: drivers.slice(0, 16),
    contentDrivers: drivers.filter((d) => !POSITION_FEATS.includes(d.feature)).slice(0, 12),
    reelResiduals,
  };
}
