import { currentIgAccount } from "./scope.mjs";
// Reel audit: one reel's MEASURED elements checked against the Lab's proven practices.
// Every check is deterministic (regex/counted frames/timestamps) and cites which model
// or table produced the evidence (hooks table, skip model, attention model, views model).
// Verdicts: pass / warn / fail for practices, info for context rows.
import { getDb, isConfigured } from "./store/supabase.mjs";
import { hookText } from "./hooks.mjs";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
export { isConfigured };

const segsOf = (sc) => {
  const p = path.join("analysis", sc + ".json");
  if (!existsSync(p)) return [];
  try { return (JSON.parse(readFileSync(p, "utf8")).transcript || {}).segments || []; } catch { return []; }
};
const holdAt3 = (rc) => {
  if (!Array.isArray(rc) || rc.length < 2 || typeof rc[0] !== "object") return null;
  const pairs = rc.map((x) => ({ t: +x.t, p: +x.p })).sort((a, b) => a.t - b.t);
  let lo = pairs[0], hi = pairs[pairs.length - 1];
  for (const a of pairs) { if (a.t <= 3) lo = a; if (a.t >= 3) { hi = a; break; } }
  return Math.round(lo.t === hi.t ? lo.p : lo.p + (hi.p - lo.p) * ((3 - lo.t) / (hi.t - lo.t)));
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

export async function reelAudit(shortcode) {
  const db = await getDb();
  const { data: r } = await db.from("reels").select("shortcode,caption,transcript_text,duration_sec,published_at,skip_rate,retention_curve,visual_stats,frame_track,reel_metrics(plays,captured_date)").eq("shortcode", shortcode).maybeSingle();
  if (!r) return null;
  let q = db.from("reels").select("skip_rate,retention_curve,published_at,reel_metrics(plays,captured_date)").not("transcript_text", "is", null);
  const __acct = currentIgAccount(); if (__acct) q = q.eq("ig_account", __acct);
  const { data: all } = await q;
  const now = Date.now();
  const latestPlays = (row) => ((row.reel_metrics || []).slice().sort((a, b) => String(b.captured_date).localeCompare(String(a.captured_date)))[0] || {}).plays || 0;
  const baseSkip = mean((all || []).map((x) => x.skip_rate).filter((v) => v != null));
  const baseHold = mean((all || []).map((x) => holdAt3(x.retention_curve)).filter((v) => v != null));
  const medViews = median((all || []).filter((x) => x.published_at && (now - new Date(x.published_at).getTime()) / 86400000 >= 5).map(latestPlays).filter((v) => v > 0));

  // ── measure this reel ──────────────────────────────────────────────────────
  const dur = Math.round(r.duration_sec || 0);
  const opener = hookText(r.shortcode, r.transcript_text);
  const t = String(r.transcript_text || "");
  const words = t.trim().split(/\s+/).filter(Boolean).length;
  const pace = dur ? +(words / dur).toFixed(1) : 0;
  const segs = segsOf(r.shortcode);
  const speechStart = segs.length ? Math.max(0, +(segs[0].start || 0).toFixed(1)) : null;
  const track = (Array.isArray(r.frame_track) ? r.frame_track : []).map((e) => ({ ...e, t: +e.t })).sort((a, b) => a.t - b.t);
  const isDemo = (e) => e && (e.sc === "screen_demo" || e.sc === "overlay_on_face" || (e.app && e.app !== "none"));
  const firstDemo = track.find(isDemo);
  const firstCut = track.find((e, i) => i > 0 && e.sc !== track[0].sc);
  let maxScene = 0;
  if (track.length) { // longest run of the same scene (track samples ~2s apart)
    let runStart = track[0].t;
    for (let i = 1; i < track.length; i++) { if (track[i].sc !== track[i - 1].sc) { maxScene = Math.max(maxScene, track[i - 1].t - runStart + 2); runStart = track[i].t; } }
    maxScene = Math.max(maxScene, (track[track.length - 1].t - runStart + 2));
  }
  const d = r.published_at ? new Date(r.published_at) : null;
  const weekend = d ? (d.getDay() === 0 || d.getDay() === 6) : null;
  const slot = d ? (d.getHours() < 12 ? "morning" : d.getHours() < 18 ? "afternoon" : "evening") : null;
  const skip = r.skip_rate ?? null;
  const hold = holdAt3(r.retention_curve);
  const views = latestPlays(r);
  const ageDays = d ? (now - d.getTime()) / 86400000 : 999;

  // ── checks ────────────────────────────────────────────────────────────────
  const checks = [];
  const add = (label, value, verdict, why) => checks.push({ label, value, verdict, why });
  const isQ = /\?/.test(opener), isCur = /(was passiert|stell dir vor|wusstest du)/i.test(opener);
  add("Question / curiosity opener", isQ || isCur ? "yes" : "no", isQ || isCur ? "pass" : "fail", "Question hooks: −25pp skips, +14.6pp hold (hooks table · skip model)");
  const timeProm = /(sekunden|minuten|stunden|tag(e|en)?)\b/i.test(opener.slice(0, 180));
  add("No time-promise in the hook", timeProm ? "has one" : "clean", timeProm ? "fail" : "pass", "“In 30 Sekunden…” openers: +13.3pp skips, −18.3pp hold (hooks table)");
  const du = /\b(du|dein\w*|dir|dich)\b/i.test(opener);
  add("Speaks to the viewer early (du)", du ? "yes" : "no", du ? "pass" : "warn", "du-openers: −8.8pp skips on n=22 (hooks table)");
  const num = /\d/.test(opener);
  add("Number in the opening line", num ? "yes" : "no", num ? "pass" : "warn", "+0.21 views · −2.5pp skips · holds per-second attention (all three models)");
  if (firstCut) add("First cut within 4s", Math.round(firstCut.t) + "s", firstCut.t <= 4 ? "pass" : firstCut.t <= 7 ? "warn" : "fail", "Long opening shots cost views (−0.25/SD) and stale scenes bleed (+0.66pp/s · attention model)");
  if (track.length) add("Demo on screen within 6s", firstDemo ? Math.round(firstDemo.t) + "s" : "never", firstDemo && firstDemo.t <= 6 ? "pass" : firstDemo && firstDemo.t <= 12 ? "warn" : "fail", "Demo seconds hold viewers (−0.7pp/s); late demos cost views (−0.17)");
  if (speechStart != null) add("No dead air at the open", speechStart + "s to first word", speechStart <= 0.6 ? "pass" : speechStart <= 1.5 ? "warn" : "fail", "Fast, continuous speech holds (−1.07pp/s · attention model)");
  if (maxScene) add("No stale scene (longest ≤ 8s)", Math.round(maxScene) + "s longest", maxScene <= 8 ? "pass" : maxScene <= 14 ? "warn" : "fail", "Drop risk climbs the longer a scene runs (sec_since_cut · attention model)");
  add("Speech pace ≥ 2.2 words/s", pace + " w/s", pace >= 2.2 ? "pass" : pace >= 1.7 ? "warn" : "fail", "Faster narration: fewer skips (−2.3pp) + per-second hold (attention model)");
  if (weekend != null) add("Posted on a weekday", weekend ? "weekend" : "weekday", weekend ? "fail" : "pass", "Weekend posts: −0.26 views · +3.5pp skips (views + skip models)");
  if (slot) add("Posting slot", slot, slot === "afternoon" ? "pass" : slot === "morning" ? "warn" : "warn", "Afternoon: −3.0pp skips · evening: +2.9pp (skip model)");
  const cta = /komment/i.test(t.slice(-300));
  add("Comment-CTA at the end", cta ? "yes" : "no", cta ? "pass" : "warn", "Your comment-magnet format drives comments/reach (measured across the catalogue)");

  // ── outcomes vs the account (context, not practice) ──────────────────────
  if (skip != null && baseSkip != null) add("Skip rate vs your average", skip + "% vs Ø " + Math.round(baseSkip) + "%", skip <= baseSkip - 3 ? "pass" : skip >= baseSkip + 3 ? "fail" : "info", "Real % who swiped away (insights)");
  if (hold != null && baseHold != null) add("3s hold vs your average", hold + "% vs Ø " + Math.round(baseHold) + "%", hold >= baseHold + 3 ? "pass" : hold <= baseHold - 3 ? "fail" : "info", "Real retention at 3s (your manual insights data)");
  if (views > 0 && medViews) add("Views vs account median", (views >= 1000 ? Math.round(views / 100) / 10 + "K" : views) + " vs " + Math.round(medViews / 100) / 10 + "K", ageDays < 5 ? "info" : views >= medViews * 2 ? "pass" : views >= medViews * 0.5 ? "info" : "fail", ageDays < 5 ? "Still cooking — posted " + Math.round(ageDays * 10) / 10 + "d ago" : "Settled views vs the account median");

  const practices = checks.filter((c) => c.verdict !== "info");
  return { shortcode: r.shortcode, posted: r.published_at, opener: opener.slice(0, 140), checks,
    score: { pass: practices.filter((c) => c.verdict === "pass").length, total: practices.length } };
}
