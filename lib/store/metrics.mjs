// Persists the live Graph-API performance metrics (one snapshot per reel per day)
// so they can be joined against the AI content/design for analysis. Upserts on
// (reel_id, captured_date): repeated refreshes the same day update the row.
import { getDb, isConfigured } from "./supabase.mjs";

export { isConfigured };

const shortcodeOf = (url) => {
  const m = String(url || "").match(/\/(?:reel|reels|p|tv)\/([^/?#]+)/i);
  return m ? m[1] : null;
};

// Pull the @handle out of meta.username ("@gptmarlon · Instagram").
const accountOf = (meta) => {
  const m = String((meta && meta.username) || "").match(/@?([A-Za-z0-9_.]+)/);
  return m ? m[1] : null;
};

const num = (v) => (v == null || isNaN(Number(v)) ? 0 : Number(v));

/** Store a payload's per-reel metrics. Best-effort; returns {stored, failed}. */
export async function storeMetrics(payload) {
  const defs = (payload && payload.defs) || [];
  if (!defs.length) return { stored: 0, failed: 0 };
  const db = await getDb();
  const account = accountOf(payload.meta);
  const today = new Date().toISOString().slice(0, 10);
  let stored = 0, failed = 0;

  for (const d of defs) {
    const shortcode = shortcodeOf(d.permalink);
    if (!shortcode) { failed++; continue; }
    try {
      // Upsert the reel row with metadata only — never touch AI fields (summary,
      // hook, transcript…), and only set columns we actually have so an AI-extracted
      // reel isn't clobbered with nulls.
      const reelRow = { shortcode };
      if (account) reelRow.ig_account = account;
      if (d.permalink && d.permalink !== "#") reelRow.permalink = d.permalink;
      if (d.ts) reelRow.published_at = new Date(d.ts).toISOString();
      if (d.cap) reelRow.caption = d.cap;
      if (d.lenKnown && d.len) reelRow.duration_sec = d.len;

      const { data: reel, error } = await db.from("reels").upsert(reelRow, { onConflict: "shortcode" }).select("id").single();
      if (error) throw new Error("reels upsert: " + error.message);

      const base = num(d.plays) || num(d.reach) || 0;
      const rate = (v) => (base ? Math.round((num(v) / base) * 1000) / 10 : 0);
      const metricRow = {
        reel_id: reel.id,
        captured_date: today,
        fetched_at: new Date().toISOString(),
        reach: num(d.reach), plays: num(d.plays), likes: num(d.likes),
        comments: num(d.comments), shares: num(d.shares), saves: num(d.saves),
        avg_watch_sec: num(d.avgWatchSec),
        total_watch_sec: d.avgWatchSec && d.plays ? Math.round(num(d.avgWatchSec) * num(d.plays)) : null,
        watch_through_pct: d.lenKnown && d.len ? Math.round((num(d.avgWatchSec) / num(d.len)) * 1000) / 10 : null,
        raw: {
          follows: num(d.follows), replays: num(d.replays), looping: !!d.looping,
          source: (payload.meta && payload.meta.source) || "live",
          rates: d.rates || { like: rate(d.likes), save: rate(d.saves), share: rate(d.shares), comment: rate(d.comments) },
        },
      };
      const { error: mErr } = await db.from("reel_metrics").upsert(metricRow, { onConflict: "reel_id,captured_date" });
      if (mErr) throw new Error("reel_metrics upsert: " + mErr.message);
      stored++;
    } catch (e) {
      failed++;
    }
  }
  return { stored, failed };
}
