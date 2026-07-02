// Second-by-second drop analysis: cross the EXACT per-second retention with the structured
// visual track (what's on screen each second) + transcript (what's said). Surfaces per-reel
// "death moments" and, across reels, which SCENE CUTS actually cost retention (excess drop
// over the reel's natural decline — so it isn't just "time passed").
import { getDb, isConfigured } from "./store/supabase.mjs";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
export { isConfigured };

const SCENE = { talking_head: "you on camera", screen_demo: "a screen demo", overlay_on_face: "a UI over your face", animation: "an animation", text_card: "a text card", b_roll: "b-roll", other: "other footage" };
const labelOf = (e) => !e ? "" : (SCENE[e.sc] || e.sc) + (e.app && e.app !== "none" ? ` (${e.app})` : "") + (e.p === 0 ? ", you off-camera" : "");

// {t,p} anchors -> per-second array [p@0, p@1, ... p@dur]
function perSecond(rc, dur) {
  const pairs = rc.map((x) => (typeof x === "object" ? { t: +x.t, p: +x.p } : { t: 0, p: +x })).sort((a, b) => a.t - b.t);
  const D = Math.round(dur || pairs[pairs.length - 1].t || 0);
  const out = [];
  for (let s = 0; s <= D; s++) {
    let lo = pairs[0], hi = pairs[pairs.length - 1];
    for (const a of pairs) { if (a.t <= s) lo = a; if (a.t >= s) { hi = a; break; } }
    out.push(lo.t === hi.t ? lo.p : lo.p + (hi.p - lo.p) * ((s - lo.t) / (hi.t - lo.t)));
  }
  return out;
}
// structured track from frame_track (preferred), else prose frames as a fallback
function buildTrack(r) {
  if (Array.isArray(r.frame_track) && r.frame_track.length) return r.frame_track.map((e) => ({ ...e, t: +e.t })).sort((a, b) => a.t - b.t);
  return (r.reel_frames || []).map((f) => ({ t: +f.t, sc: "other", app: "none", p: 1, _prose: (f.visual || "").slice(0, 140) })).sort((a, b) => a.t - b.t);
}
const at = (track, s) => track.reduce((b, e) => (Math.abs(e.t - s) < Math.abs((b ? b.t : 1e9) - s) ? e : b), track[0]);
const transcriptSegments = (sc) => { const p = path.join("analysis", sc + ".json"); if (!existsSync(p)) return []; try { const j = JSON.parse(readFileSync(p, "utf8")); return (j.transcript && j.transcript.segments) || []; } catch { return []; } };
const saidAt = (segs, s) => { const seg = segs.find((x) => s >= (x.start || 0) - 0.5 && s <= (x.end || 0) + 0.5) || segs.find((x) => (x.start || 0) >= s); return seg ? String(seg.text || "").trim() : ""; };

/** One reel: hook survival, the opening scroll-off, and the actionable mid-video death moments. */
export async function reelDrops(shortcode, { topN = 4, minDrop = 5 } = {}) {
  const db = await getDb();
  const { data: r } = await db.from("reels").select("id,shortcode,duration_sec,retention_curve,frame_track,reel_frames(t,visual)").eq("shortcode", shortcode).maybeSingle();
  if (!r || !Array.isArray(r.retention_curve) || r.retention_curve.length < 3) return null;
  const ps = perSecond(r.retention_curve, r.duration_sec);
  const track = buildTrack(r), segs = transcriptSegments(shortcode);
  const hook3 = Math.round(ps[Math.min(3, ps.length - 1)]);
  const openingDrop = Math.round(ps[0] - ps[Math.min(3, ps.length - 1)]);
  const drops = [];
  for (let s = 4; s < ps.length; s++) { const d = ps[s - 1] - ps[s]; if (d >= minDrop) drops.push({ sec: s, from: Math.round(ps[s - 1]), to: Math.round(ps[s]), dropPts: Math.round(d * 10) / 10 }); }
  drops.sort((a, b) => b.dropPts - a.dropPts);
  const moments = drops.slice(0, topN).sort((a, b) => a.sec - b.sec).map((d) => {
    const here = at(track, d.sec), before = at(track, d.sec - 2);
    const cut = here && before && here.sc !== before.sc;
    return { ...d, onScreen: here && here._prose ? here._prose : labelOf(here), cut, transition: cut ? `${SCENE[before.sc] || before.sc} → ${SCENE[here.sc] || here.sc}` : "", said: saidAt(segs, d.sec).slice(0, 120) };
  });
  return { shortcode: r.shortcode, dur: r.duration_sec, perSec: ps.map((p) => Math.round(p)), hook3, openingDrop, moments, hasTrack: Array.isArray(r.frame_track) && r.frame_track.length > 0 };
}

/** Across reels: hook survival, where mid-video cliffs cluster, and which CUTS cost the most
 *  retention beyond the natural decline (excess drop). */
export async function dropPatterns() {
  const db = await getDb();
  let q = db.from("reels").select("shortcode,duration_sec,retention_curve,frame_track,reel_frames(t,visual)").not("retention_curve", "is", null);
  if (process.env.IG_ACCOUNT) q = q.eq("ig_account", process.env.IG_ACCOUNT);
  const { data } = await q;
  const reels = (data || []).filter((r) => Array.isArray(r.retention_curve) && r.retention_curve.length >= 3);
  let hookSum = 0, n = 0;
  const midBuckets = { "3-6s": 0, "6-10s": 0, "10-20s": 0, "20s+": 0 };
  const cliffs = [], trans = {};
  for (const r of reels) {
    n++;
    const ps = perSecond(r.retention_curve, r.duration_sec);
    hookSum += ps[Math.min(3, ps.length - 1)];
    const track = buildTrack(r);
    const decayPerSec = ps.length > 1 ? (ps[0] - ps[ps.length - 1]) / (ps.length - 1) : 0; // this reel's natural decline
    // biggest mid-video cliff
    let big = { dropPts: 0, sec: 0 };
    for (let s = 4; s < ps.length; s++) { const d = ps[s - 1] - ps[s]; if (d > big.dropPts) big = { dropPts: d, sec: s }; }
    if (big.dropPts >= 5) { const s = big.sec; midBuckets[s <= 6 ? "3-6s" : s <= 10 ? "6-10s" : s <= 20 ? "10-20s" : "20s+"]++; cliffs.push({ shortcode: r.shortcode, sec: s, dropPts: Math.round(big.dropPts), scene: labelOf(at(track, s)) }); }
    // scene-cut cost: excess drop across each cut vs natural decline over the same gap
    if (Array.isArray(r.frame_track) && r.frame_track.length) {
      for (let i = 1; i < track.length; i++) {
        const a0 = track[i - 1], a1 = track[i]; if (a0.sc === a1.sc) continue;
        const t0 = Math.round(a0.t), t1 = Math.round(a1.t); if (t1 >= ps.length || t0 < 0) continue;
        const actual = ps[t0] - ps[t1], expected = decayPerSec * (t1 - t0), excess = actual - expected;
        const key = `${SCENE[a0.sc] || a0.sc} → ${SCENE[a1.sc] || a1.sc}`;
        (trans[key] || (trans[key] = { count: 0, excess: 0, actual: 0 })); trans[key].count++; trans[key].excess += excess; trans[key].actual += actual;
      }
    }
  }
  cliffs.sort((a, b) => b.dropPts - a.dropPts);
  const cuts = Object.entries(trans).map(([k, v]) => ({ transition: k, n: v.count, avgExcessDrop: +(v.excess / v.count).toFixed(1), avgDrop: +(v.actual / v.count).toFixed(1) }))
    .filter((c) => c.n >= 3).sort((a, b) => b.avgExcessDrop - a.avgExcessDrop);
  return { n, avgHookRetention: Math.round(hookSum / (n || 1)), midCliffBuckets: midBuckets, costlyCuts: cuts, worstCliffs: cliffs.slice(0, 8) };
}
