// Minimal Instagram Graph API client. Node 22's global fetch + zero deps.
import { probeDurationFromUrl } from "./mp4duration.mjs";

// Host is read lazily (after .env loads). For an Instagram-login token (IGAA…)
// set GRAPH_HOST=graph.instagram.com; the default is the Facebook-login Graph API.
const base = (v) => `https://${process.env.GRAPH_HOST || "graph.facebook.com"}/${v}`;

function cfg() {
  return {
    token: process.env.IG_ACCESS_TOKEN || process.env.ACCESS_TOKEN || "",
    userId: process.env.IG_USER_ID || "",
    version: process.env.GRAPH_VERSION || "v21.0",
  };
}

export function isConfigured() {
  const { token, userId } = cfg();
  return !!(token && userId);
}

async function gget(path, params) {
  const { token, version } = cfg();
  const url = new URL(base(version) + path);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    const err = new Error(
      `Graph API ${res.status}: ${e.message || res.statusText} (at ${path})`
    );
    err.graph = e;
    throw err;
  }
  return json;
}

export async function fetchProfile() {
  const { userId } = cfg();
  try {
    return await gget(`/${userId}`, {
      fields: "username,followers_count,media_count",
    });
  } catch {
    return {};
  }
}

const MEDIA_FIELDS =
  "id,caption,media_type,media_product_type,permalink,timestamp," +
  "thumbnail_url,media_url,like_count,comments_count";

export async function fetchAllMedia({ max = 80 } = {}) {
  const { userId } = cfg();
  const out = [];
  let page = await gget(`/${userId}/media`, { fields: MEDIA_FIELDS, limit: 50 });
  for (;;) {
    for (const m of page.data || []) out.push(m);
    const next = page.paging && page.paging.next;
    if (out.length >= max || !next) break;
    const res = await fetch(next);
    page = await res.json().catch(() => ({}));
    if (!page || page.error) break;
  }
  return out.slice(0, max);
}

// Requested per-reel metrics. The Graph API rejects the WHOLE call if any one
// metric is unsupported for that media, so we retry, peeling off whichever
// metric the error names until the call succeeds.
const REEL_METRICS = [
  "reach",
  "likes",
  "comments",
  "shares",
  "saved",
  "total_interactions",
  "ig_reels_avg_watch_time",
  "ig_reels_video_view_total_time",
  "plays",
  "clips_replays_count",
  "ig_reels_aggregated_all_plays_count",
];

export async function fetchMediaInsights(id) {
  let metrics = REEL_METRICS.slice();
  for (let attempt = 0; attempt < 8 && metrics.length; attempt++) {
    try {
      const json = await gget(`/${id}/insights`, { metric: metrics.join(",") });
      const out = {};
      for (const row of json.data || []) {
        const v = row.values && row.values[0] ? row.values[0].value : undefined;
        out[row.name] = v && typeof v === "object" ? sumObj(v) : v;
      }
      return out;
    } catch (e) {
      const bad = offendingMetric(e, metrics);
      metrics = bad ? metrics.filter((m) => m !== bad) : metrics.slice(0, -1);
    }
  }
  return {};
}

export async function fetchAccountTrend(days = 90) {
  const { userId } = cfg();
  const until = Math.floor(Date.now() / 1000);
  const since = until - days * 86400;
  const trend = { reachS: [], playsS: [], playsModeled: true };
  try {
    const j = await gget(`/${userId}/insights`, {
      metric: "reach",
      period: "day",
      since,
      until,
    });
    trend.reachS = ((j.data && j.data[0] && j.data[0].values) || []).map(
      (v) => Number(v.value) || 0
    );
  } catch {}
  for (const metric of ["views", "impressions"]) {
    try {
      const j = await gget(`/${userId}/insights`, {
        metric,
        period: "day",
        since,
        until,
      });
      const vals = (j.data && j.data[0] && j.data[0].values) || [];
      if (vals.length) {
        trend.playsS = vals.map((v) => Number(v.value) || 0);
        trend.playsModeled = false;
        break;
      }
    } catch {}
  }
  return trend;
}

export async function collectReels({ max = 40 } = {}) {
  const profile = await fetchProfile();
  const media = await fetchAllMedia({ max: max * 2 });
  const reels = media
    .filter((m) => m.media_product_type === "REELS" || m.media_type === "VIDEO")
    .slice(0, max);

  const items = [];
  for (const m of reels) {
    const insights = await fetchMediaInsights(m.id);
    let len = null;
    let lenKnown = false;
    if (m.media_url) {
      try {
        len = await probeDurationFromUrl(m.media_url);
        lenKnown = len > 0;
      } catch {
        /* duration stays unknown; dashboard handles the gap */
      }
    }
    items.push({ media: m, insights, len, lenKnown });
  }

  const trend = await fetchAccountTrend(90);
  return { items, trend, profile };
}

function offendingMetric(e, metrics) {
  const msg = (e && e.graph && e.graph.message) || (e && e.message) || "";
  for (const m of metrics) if (msg.includes(m)) return m;
  return null;
}

function sumObj(o) {
  let s = 0;
  for (const k in o) s += Number(o[k]) || 0;
  return s;
}
