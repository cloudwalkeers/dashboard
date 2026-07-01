// Maps raw Graph API responses into the flat "payload" the dashboard renders:
//   { defs: [...one entry per reel...], trend: {...}, meta: {...} }

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function toPayload(raw, { source = "live" } = {}) {
  const defs = (raw.items || []).map(mapReel);
  defs.sort((a, b) => b.ts - a.ts);
  const trend = normalizeTrend(raw.trend, defs);
  const p = raw.profile || {};
  return {
    defs,
    trend,
    meta: {
      source,
      fetchedAt: Date.now(),
      count: defs.length,
      username: p.username ? "@" + p.username + " · Instagram" : "Instagram reels",
      followers: p.followers_count != null ? Number(p.followers_count) : null,
    },
  };
}

function mapReel({ media, insights, len, lenKnown }) {
  const ts = Date.parse(media.timestamp) || Date.now();
  const reach = num(insights.reach);
  const plays =
    num(insights.views) ||
    num(insights.plays) ||
    num(insights.ig_reels_aggregated_all_plays_count) ||
    reach;
  const likes = num(insights.likes) || num(media.like_count);
  const comments = num(insights.comments) || num(media.comments_count);
  const shares = num(insights.shares);
  const saves = num(insights.saved);
  const replays =
    num(insights.clips_replays_count) ||
    Math.max(0, num(insights.ig_reels_aggregated_all_plays_count) - plays) ||
    Math.max(0, plays - reach); // views include replays; (views − reach) ≈ replays

  const totalWatchMs = num(insights.ig_reels_video_view_total_time);
  const avgWatchMs = num(insights.ig_reels_avg_watch_time);
  const avgWatchSec = avgWatchMs
    ? avgWatchMs / 1000
    : totalWatchMs && plays
    ? totalWatchMs / 1000 / plays
    : 0;

  // Looping signal: watch time per account vs. the real length.
  const perAccount = totalWatchMs && reach ? totalWatchMs / 1000 / reach : 0;
  const looping =
    lenKnown && len ? avgWatchSec > len * 1.02 || perAccount > len * 1.05 : false;

  const rates = engagementRates({ likes, saves, shares, comments, plays, reach });

  return {
    id: media.id,
    cap: cleanCaption(media.caption),
    permalink: media.permalink || "#",
    thumb: media.thumbnail_url || null, // reel cover from the Graph API (live path had no picture)
    ts,
    date: fmtDate(ts),
    time: fmtTime(ts),
    len: lenKnown ? round1(len) : null,
    lenKnown: !!lenKnown,
    reach,
    plays,
    replays,
    likes,
    comments,
    shares,
    saves,
    follows: 0, // not available per-reel via the Graph API
    avgWatchSec: round1(avgWatchSec),
    looping,
    rates,
  };
}

// Per-reel engagement rates (% of views). like/save/share/comment come straight
// from the insights; skip & repost are NOT exposed by the Graph API → null.
export function engagementRates({ likes = 0, saves = 0, shares = 0, comments = 0, plays = 0, reach = 0 }) {
  const base = plays || reach || 0;
  const r = (v) => (base ? Math.round((v / base) * 1000) / 10 : 0);
  return { like: r(likes), save: r(saves), share: r(shares), comment: r(comments), skip: null, repost: null };
}

function normalizeTrend(trend, defs) {
  let reachS = (trend && trend.reachS) || [];
  let playsS = (trend && trend.playsS) || [];
  let reachModeled = false;
  let playsModeled = !!(trend && trend.playsModeled);

  if (!reachS.length) {
    const avg = defs.length
      ? defs.reduce((s, d) => s + d.reach, 0) / defs.length / 8
      : 3000;
    reachS = [];
    for (let i = 0; i < 90; i++) {
      reachS.push(
        Math.max(300, Math.round(avg * (1 + 0.4 * Math.sin(i / 6) + 0.2 * Math.sin(i / 2.3))))
      );
    }
    reachModeled = true;
  }
  if (!playsS.length) {
    const ratio =
      sumField(defs, "plays") / Math.max(1, sumField(defs, "reach")) || 1.3;
    playsS = reachS.map((v) => Math.round(v * ratio));
    playsModeled = true;
  }
  return { reachS, playsS, reachModeled, playsModeled };
}

const num = (v) => (v == null || isNaN(Number(v)) ? 0 : Number(v));
const round1 = (n) => Math.round(n * 10) / 10;
const sumField = (arr, f) => arr.reduce((s, x) => s + (x[f] || 0), 0);

function cleanCaption(c) {
  if (!c) return "Untitled reel";
  const first = String(c).split("\n")[0].trim();
  const t = first || String(c).trim();
  return t.length > 64 ? t.slice(0, 63).trimEnd() + "…" : t;
}

function fmtDate(ts) {
  const d = new Date(ts);
  return MON[d.getMonth()] + " " + d.getDate();
}
function fmtTime(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return h + ":" + String(m).padStart(2, "0") + " " + ap;
}
