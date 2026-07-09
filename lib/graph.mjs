// Minimal Instagram Graph API client. Node 22's global fetch + zero deps.
// Multi-tenant: when a web request is scoped to a logged-in creator (lib/scope.mjs),
// every call here uses THAT creator's own token on graph.instagram.com — so the
// whole live pipeline (profile, media, insights, trends) runs as them. Outside a
// request scope (CLI scripts), the env credentials apply exactly as before.
import { probeDurationFromUrl } from "./mp4duration.mjs";
import { currentIgToken } from "./scope.mjs";

// Host is read lazily (after .env loads). Creator tokens are Instagram-login
// tokens, so a scoped request always talks to graph.instagram.com; the env
// GRAPH_HOST only governs the CLI/legacy path.
const base = (v) => {
  const host = currentIgToken() ? "graph.instagram.com" : process.env.GRAPH_HOST || "graph.facebook.com";
  return `https://${host}/${v}`;
};

function cfg() {
  const scoped = currentIgToken();
  return {
    token: scoped || process.env.IG_ACCESS_TOKEN || process.env.ACCESS_TOKEN || "",
    userId: process.env.IG_USER_ID || "",
    version: process.env.GRAPH_VERSION || "v21.0",
    scoped: !!scoped,
  };
}

// The account node to query. Instagram-login tokens (graph.instagram.com)
// resolve the token owner via "me"; the Facebook-login Graph API uses the
// numeric IG business id.
function acct() {
  if (currentIgToken()) return "me";
  const onInstagramHost = (process.env.GRAPH_HOST || "").includes("graph.instagram.com");
  return onInstagramHost ? "me" : cfg().userId || "me";
}

export function isConfigured() {
  const { token, userId, scoped } = cfg();
  if (scoped) return true; // creator token needs no user id ("me")
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
  try {
    return await gget(`/${acct()}`, {
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
  const out = [];
  let page = await gget(`/${acct()}/media`, { fields: MEDIA_FIELDS, limit: 50 });
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
// Valid per-reel metrics on the Instagram API (graph.instagram.com). "plays",
// "clips_replays_count" and "ig_reels_aggregated_all_plays_count" were retired —
// "views" is the replacement for total plays.
const REEL_METRICS = [
  "views",
  "reach",
  "likes",
  "comments",
  "shares",
  "saved",
  "total_interactions",
  "ig_reels_avg_watch_time",
  "ig_reels_video_view_total_time",
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
      // The API reports the bad metric positionally, e.g. "metric[8] must be …".
      // Prefer that index; the message also lists all valid names, so matching by
      // name would wrongly drop valid metrics.
      const idx = offendingIndex(e);
      if (idx >= 0 && idx < metrics.length) metrics = metrics.filter((_, i) => i !== idx);
      else {
        const bad = offendingMetric(e, metrics);
        metrics = bad ? metrics.filter((m) => m !== bad) : metrics.slice(0, -1);
      }
    }
  }
  return {};
}

export async function fetchAccountTrend(days = 90) {
  const until = Math.floor(Date.now() / 1000);
  const since = until - days * 86400;
  const trend = { reachS: [], playsS: [], playsModeled: true };
  try {
    const j = await gget(`/${acct()}/insights`, {
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
      const j = await gget(`/${acct()}/insights`, {
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

// Hashtag discovery (Instagram Graph API, graph.facebook.com + an IG Business
// account id). Returns the hashtag node id, then its top/recent media. NOTE:
// not available on graph.instagram.com (Instagram-login) tokens.
export async function searchHashtag(q) {
  const cleaned = String(q).replace(/^#/, "").trim();
  const j = await gget(`/ig_hashtag_search`, { user_id: cfg().userId, q: cleaned });
  return (j.data && j.data[0] && j.data[0].id) || null;
}

export async function hashtagMedia(hashtagId, { type = "top", limit = 30 } = {}) {
  const edge = type === "recent" ? "recent_media" : "top_media";
  const fields = "id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count";
  const j = await gget(`/${hashtagId}/${edge}`, { user_id: cfg().userId, fields, limit });
  return j.data || [];
}

export async function collectReels({ max = 40, durations = null } = {}) {
  const profile = await fetchProfile();
  const media = await fetchAllMedia({ max: max * 2 });
  const reels = media
    .filter((m) => m.media_product_type === "REELS" || m.media_type === "VIDEO")
    .slice(0, max);
  const scOf = (u) => { const m = String(u || "").match(/\/reels?\/([^/?#]+)/i); return m ? m[1] : null; };

  // Fetch insights concurrently, and SKIP the slow per-reel duration probe when we
  // already know the length (passed in from Supabase). Probing every mp4 header
  // sequentially was the bottleneck that made the live load take ~a minute+.
  const items = await mapLimit(reels, 6, async (m) => {
    const insights = await fetchMediaInsights(m.id);
    const sc = scOf(m.permalink);
    let len = durations && sc && durations[sc] ? Number(durations[sc]) : null;
    let lenKnown = !!(len && len > 0);
    if (!lenKnown && m.media_url) {
      try { len = await probeDurationFromUrl(m.media_url); lenKnown = len > 0; } catch { /* unknown */ }
    }
    return { media: m, insights, len, lenKnown };
  });

  const trend = await fetchAccountTrend(90);
  return { items, trend, profile };
}

// Bounded-concurrency map — keeps `limit` calls in flight, preserves input order.
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const worker = async () => { while (i < list.length) { const idx = i++; out[idx] = await fn(list[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

function offendingIndex(e) {
  const msg = (e && e.graph && e.graph.message) || (e && e.message) || "";
  const m = /metric\[(\d+)\]/.exec(msg);
  return m ? Number(m[1]) : -1;
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
