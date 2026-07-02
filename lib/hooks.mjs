// Hook analysis — the opening LINE itself, measured. The hook text is extracted from the
// timestamped transcript (what is actually said in the first ~3.5s), classified into a
// deterministic regex taxonomy (no LLM opinions), and each pattern is contrasted on the
// two outcomes a hook mechanically controls: the SKIP rate (swipe decision) and the
// 3-second HOLD (real retention). Also returns every reel's opening line + its numbers,
// so the best and worst openers can be read verbatim.
import { getDb, isConfigured } from "./store/supabase.mjs";
import { topicOf } from "./predict.mjs";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
export { isConfigured };

const PATTERNS = [
  { key: "question", label: "Question hook (…?)", re: /\?/ },
  { key: "curiosity", label: "Curiosity setup („was passiert, wenn …“)", re: /(was passiert|stell dir vor|wusstest du|was w[äa]re wenn)/i },
  { key: "number", label: "A number in the opening line", re: /\d/ },
  { key: "warning", label: "Warning / negation („hör auf“, „Fehler“)", re: /(h[öo]r auf|nie wieder|vergiss|fehler|niemals|falsch|schluss mit)/i },
  { key: "secret", label: "Insider / secret („niemand sagt dir“, „Trick“)", re: /(niemand|keiner|geheim|trick|hack|insider|versteckt)/i },
  { key: "time_promise", label: "Time promise („in 30 Sekunden“)", re: /(sekunden|minuten|stunden|tag(e|en)?)\b/i },
  { key: "direct_address", label: "Speaks to the viewer (du/dich)", re: /\b(du|dein\w*|dir|dich)\b/i },
  { key: "command", label: "Command opener („Schau …“, „Mach …“)", re: /^\s*(schau|h[öo]r|nutz|mach|probier|vergiss|speicher|teste|stopp?)\b/i },
];

function hookText(shortcode, transcript) {
  const p = path.join("analysis", shortcode + ".json");
  if (existsSync(p)) {
    try {
      const segs = (JSON.parse(readFileSync(p, "utf8")).transcript || {}).segments || [];
      const t = segs.filter((s) => (s.start || 0) < 3.5).map((s) => String(s.text || "").trim()).join(" ").trim();
      if (t) return t;
    } catch { /* fall through to transcript */ }
  }
  const first = String(transcript || "").split(/(?<=[.!?])\s+/)[0] || "";
  return first.slice(0, 160);
}
const holdAt3 = (rc) => {
  if (!Array.isArray(rc) || rc.length < 2 || typeof rc[0] !== "object") return null;
  const pairs = rc.map((x) => ({ t: +x.t, p: +x.p })).sort((a, b) => a.t - b.t);
  let lo = pairs[0], hi = pairs[pairs.length - 1];
  for (const a of pairs) { if (a.t <= 3) lo = a; if (a.t >= 3) { hi = a; break; } }
  return Math.round(lo.t === hi.t ? lo.p : lo.p + (hi.p - lo.p) * ((3 - lo.t) / (hi.t - lo.t)));
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export async function hookAnalysis() {
  const db = await getDb();
  let q = db.from("reels").select("shortcode,transcript_text,skip_rate,retention_curve,published_at,reel_metrics(plays,captured_date)").not("transcript_text", "is", null);
  if (process.env.IG_ACCOUNT) q = q.eq("ig_account", process.env.IG_ACCOUNT);
  const { data } = await q;
  const now = Date.now();
  const reels = (data || []).map((r) => {
    const m = (r.reel_metrics || []).slice().sort((a, b) => String(b.captured_date).localeCompare(String(a.captured_date)))[0] || {};
    const text = hookText(r.shortcode, r.transcript_text);
    return { shortcode: r.shortcode, text, skip: r.skip_rate ?? null, hold3: holdAt3(r.retention_curve), views: m.plays || 0,
      topic: topicOf(r.transcript_text), ageDays: r.published_at ? (now - new Date(r.published_at).getTime()) / 86400000 : 999,
      patterns: PATTERNS.filter((p) => p.re.test(text)).map((p) => p.key) };
  }).filter((r) => r.text && (r.skip != null || r.hold3 != null));

  const patterns = PATTERNS.map((p) => {
    const withP = reels.filter((r) => r.patterns.includes(p.key));
    const without = reels.filter((r) => !r.patterns.includes(p.key));
    if (withP.length < 5 || without.length < 5) return null; // too thin to contrast
    const sW = mean(withP.filter((r) => r.skip != null).map((r) => r.skip));
    const sO = mean(without.filter((r) => r.skip != null).map((r) => r.skip));
    const hW = mean(withP.filter((r) => r.hold3 != null).map((r) => r.hold3));
    const hO = mean(without.filter((r) => r.hold3 != null).map((r) => r.hold3));
    return { key: p.key, label: p.label, n: withP.length, nWithout: without.length,
      skipDelta: sW != null && sO != null ? +(sW - sO).toFixed(1) : null,
      holdDelta: hW != null && hO != null ? +(hW - hO).toFixed(1) : null };
  }).filter(Boolean).sort((a, b) => Math.abs(b.skipDelta ?? 0) - Math.abs(a.skipDelta ?? 0));

  // topic table — DESCRIPTIVE only: adding topic to the views model was ablated and it
  // hurt out-of-sample accuracy (thin cells at this N), so it stays out of the predictor.
  const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const byTopic = {};
  for (const r of reels) (byTopic[r.topic] ||= []).push(r);
  const topics = Object.entries(byTopic).map(([k, v]) => {
    const settled = v.filter((r) => r.views > 0 && r.ageDays >= 5); // exclude still-cooking views
    return { key: k, n: v.length, thin: v.length < 5,
      medViews: med(settled.map((r) => r.views)),
      skip: mean(v.filter((r) => r.skip != null).map((r) => r.skip)),
      hold: mean(v.filter((r) => r.hold3 != null).map((r) => r.hold3)) };
  }).sort((a, b) => b.n - a.n);

  return { n: reels.length, patterns, topics, reels: reels.sort((a, b) => (a.skip ?? 99) - (b.skip ?? 99)) };
}
