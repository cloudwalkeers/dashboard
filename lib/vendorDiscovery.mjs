// Vendor-powered discovery (the "sandcastle" lane): a scraping-API provider gives us
// hashtag results WITH reel view counts — which the official API never exposes — so
// we can compute outlier scores. Provider-agnostic adapter; HikerAPI is the default
// (pay-per-request, ~$0.0006/call, no monthly minimum). One platform API key serves
// every client; results are public content and each creator's finds stay on their board.
const PROVIDER = () => (process.env.DISCOVERY_VENDOR || "hikerapi").toLowerCase();
const BASE = "https://api.hikerapi.com";

export function vendorConfigured() {
  return !!process.env.HIKERAPI_KEY;
}

/** One authenticated GET to the vendor → parsed JSON, or throws with the vendor's message. */
async function hikerGet(pathAndQuery) {
  if (PROVIDER() !== "hikerapi") throw new Error("Unknown DISCOVERY_VENDOR: " + PROVIDER());
  const key = process.env.HIKERAPI_KEY;
  const res = await fetch(BASE + pathAndQuery, { headers: { "x-access-key": key, accept: "application/json" } });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (json && (json.detail || json.message || json.error)) || res.statusText;
    const e = new Error(`Discovery vendor ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg).slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

/** Search a hashtag through the vendor → normalized items (with views) or throws. */
export async function vendorHashtag(tag, { type = "top" } = {}) {
  const edge = type === "recent" ? "recent" : "top";
  const json = await hikerGet(`/v1/hashtag/medias/${edge}?name=${encodeURIComponent(String(tag).replace(/^#/, "").trim())}`);
  const list = Array.isArray(json) ? json : (json && (json.medias || json.items || json.data || json.results)) || [];
  return list.map(normalizeMedia).filter((m) => m && m.shortcode);
}

function normalizeUserShort(raw) {
  if (!raw || typeof raw !== "object") return null;
  const x = raw.user || raw.account || raw.node || raw;
  const pk = x.pk || x.id || x.pk_id || null;
  if (!x.username) return null;
  return {
    igUserId: pk != null ? String(pk) : null,
    username: String(x.username).toLowerCase(),
    fullName: x.full_name || null,
    avatar: x.profile_pic_url || x.profile_pic_url_hd || null,
    isVerified: !!x.is_verified,
    isPrivate: !!x.is_private,
    followerCount: firstNum(x.follower_count, x.followers),
  };
}

/** Resolve a handle → profile (pk + followers). Tries v2, falls back to v1 — v2's
 *  by/username flakes with false 404s, and v1 returns a richer flat object anyway. */
export async function vendorUser(username) {
  const handle = String(username || "").replace(/^@/, "").trim().toLowerCase();
  if (!handle) throw new Error("username required");
  let u = null;
  try {
    const json = await hikerGet(`/v2/user/by/username?username=${encodeURIComponent(handle)}`);
    u = (json && (json.user || json.data)) || null;
  } catch (e) {
    if (e.status && e.status !== 404 && e.status !== 410) throw e; // real error, not a miss
  }
  if (!u || !(u.pk || u.id)) {
    const json = await hikerGet(`/v1/user/by/username?username=${encodeURIComponent(handle)}`);
    u = (json && (json.user || json)) || null;
  }
  const pk = u && (u.pk || u.id || u.pk_id);
  if (!pk) throw new Error(`Couldn't find @${handle} on Instagram.`);
  return {
    igUserId: String(pk),
    username: u.username || handle,
    fullName: u.full_name || null,
    followerCount: firstNum(u.follower_count, u.followers, u.edge_followed_by && u.edge_followed_by.count),
    avatar: u.profile_pic_url || u.profile_pic_url_hd || null,
    isPrivate: !!u.is_private,
  };
}

/** Type-ahead account search → up to `limit` matching accounts (pk + name + avatar). */
export async function vendorSearchAccounts(query, { limit = 8 } = {}) {
  const q = String(query || "").replace(/^@/, "").trim();
  if (q.length < 2) return [];
  const json = await hikerGet(`/v2/fbsearch/accounts?query=${encodeURIComponent(q)}`);
  const list = (json && (json.users || json.items || json.data || json.results)) || (Array.isArray(json) ? json : []);
  return (list || []).map(normalizeUserShort).filter((u) => u && u.igUserId).slice(0, limit);
}

/** Suggested/related creators for a seed account (the "creators like X" endpoint). */
export async function vendorRelated(igUserId, { limit = 15 } = {}) {
  if (!igUserId) throw new Error("igUserId required");
  const json = await hikerGet(`/v2/user/suggested/profiles?user_id=${encodeURIComponent(igUserId)}`);
  const list = (json && (json.users || json.items || json.data || json.results)) || (Array.isArray(json) ? json : []);
  return (list || []).map(normalizeUserShort).filter((u) => u && u.igUserId && !u.isPrivate).slice(0, limit);
}

/** The creator's most recent reels. One request per PAGE (~12 reels each); `pages`
 *  controls depth — 1 for routine sweeps, more for the one-time backfill. An account
 *  with no reels is not an error — returns an empty list on a 404. */
export async function vendorUserClips(igUserId, { amount = null, pages = 1 } = {}) {
  if (!igUserId) throw new Error("igUserId required");
  const out = [];
  let pageId = null;
  for (let p = 0; p < Math.max(1, pages); p++) {
    let json;
    try {
      json = await hikerGet(`/v2/user/clips?user_id=${encodeURIComponent(igUserId)}` + (pageId ? `&page_id=${encodeURIComponent(pageId)}` : ""));
    } catch (e) {
      if (e.status === 404) break;
      throw e;
    }
    // PageResponse: media list nests under a few possible keys; items may be bare
    // media or wrapped as { media: {...} }; the next-page token name varies too.
    const container = (json && (json.response || json)) || {};
    const rawList = Array.isArray(container)
      ? container
      : (container.items || container.medias || container.data || container.results || json.items || []);
    const batch = (rawList || [])
      .map((it) => normalizeMedia(it && (it.media || it.node) ? it.media || it.node : it))
      .filter((m) => m && m.shortcode);
    out.push(...batch);
    pageId = (json && (json.next_page_id || json.page_id)) || (container && (container.next_page_id || container.next_max_id)) || null;
    if (!batch.length || !pageId) break;
  }
  const seen = new Set();
  return out
    .filter((m) => (seen.has(m.shortcode) ? false : (seen.add(m.shortcode), true)))
    // guarantee "the latest N" regardless of the vendor's page ordering
    .sort((a, b) => (Date.parse(b.publishedAt || 0) || 0) - (Date.parse(a.publishedAt || 0) || 0))
    .slice(0, amount || out.length);
}

// Instagram private-API media objects vary by provider/version — probe the common
// field names defensively rather than assuming one exact shape.
function normalizeMedia(m) {
  if (!m || typeof m !== "object") return null;
  const user = m.user || m.owner || {};
  const shortcode = m.code || m.shortcode || (typeof m.permalink === "string" && (m.permalink.match(/\/(?:reel|reels|p|tv)\/([^/?#]+)/i) || [])[1]) || null;
  const views = firstNum(m.play_count, m.ig_play_count, m.view_count, m.video_view_count, m.fb_play_count);
  const likes = firstNum(m.like_count, m.likes);
  const comments = firstNum(m.comment_count, m.comments_count);
  const takenAt = m.taken_at_ts || m.taken_at || m.timestamp || null; // unix seconds, ms, or ISO string
  const thumb = m.thumbnail_url
    || (m.image_versions2 && m.image_versions2.candidates && m.image_versions2.candidates[0] && m.image_versions2.candidates[0].url)
    || (Array.isArray(m.image_versions) && m.image_versions[0] && m.image_versions[0].url)
    || m.display_uri || m.display_url || null;
  const caption = (m.caption_text != null ? m.caption_text : (m.caption && (m.caption.text || m.caption)) || "") || "";
  const audio = audioOf(m);
  const coauthors = Array.isArray(m.coauthor_producers) ? m.coauthor_producers.length : 0;
  return {
    shortcode,
    permalink: "https://www.instagram.com/reel/" + shortcode + "/",
    account: user.username || null,
    igUserId: user.pk != null ? String(user.pk) : (user.id != null ? String(user.id) : null),
    caption: String(caption).slice(0, 1000),
    thumbnail: thumb,
    media_type: m.media_type === 2 || m.product_type === "clips" ? "VIDEO" : (m.media_type === 8 ? "CAROUSEL_ALBUM" : m.media_type === 1 ? "IMAGE" : String(m.media_type || "")),
    likes, comments,
    views,
    durationSec: firstNum(m.video_duration, m.duration, m.clips_metadata && m.clips_metadata.video_duration),
    audioId: audio.id,
    audioTitle: audio.title,
    audioArtist: audio.artist,
    isCollab: coauthors > 0 || !!m.is_collab,
    publishedAt: toIso(takenAt),
    raw: { code: shortcode, play_count: views, username: user.username || null, product_type: m.product_type || null },
  };
}

// Instagram encodes reel audio two ways: licensed music (music_info) and creator
// original audio (original_sound_info). Probe both; the cluster/asset id is what lets
// us group unrelated creators onto the same trending sound.
function audioOf(m) {
  const cm = m.clips_metadata || m.music_metadata || {};
  const music = cm.music_info || m.music_info || {};
  const asset = (music.music_asset_info) || (music.music_consumption_info) || {};
  const orig = cm.original_sound_info || m.original_sound_info || {};
  const id = firstStr(asset.audio_cluster_id, music.audio_cluster_id, orig.audio_asset_id, orig.original_media_id, cm.audio_ranking_info && cm.audio_ranking_info.best_audio_cluster_id);
  const title = firstStr(asset.title, music.title, orig.original_audio_title, cm.original_sound_title);
  const artist = firstStr(asset.display_artist, music.display_artist, orig.ig_artist && orig.ig_artist.username);
  return { id: id || null, title: title || null, artist: artist || null };
}

function firstStr(...vals) {
  for (const v of vals) if (v != null && String(v).trim()) return String(v).trim();
  return null;
}

function firstNum(...vals) {
  for (const v of vals) if (v != null && !isNaN(Number(v))) return Number(v);
  return null;
}

/** Median of a numeric list (ignores null/≤0). Returns null if fewer than 1 value. */
export function median(nums) {
  const v = (nums || []).map(Number).filter((n) => n != null && !isNaN(n) && n > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// taken_at arrives as unix seconds, unix ms, or an ISO string depending on endpoint.
function toIso(v) {
  if (v == null) return null;
  const n = Number(v);
  const d = isNaN(n) ? new Date(String(v)) : new Date(n < 2e10 ? n * 1000 : n);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Outlier score per item: views ÷ median views of the batch (the sandcastle-style
 *  "this reel is doing N× what's normal here" signal). */
export function scoreOutliers(items) {
  const views = items.map((i) => i.views).filter((v) => v != null && v > 0).sort((a, b) => a - b);
  if (views.length < 3) return items;
  const mid = Math.floor(views.length / 2);
  const median = views.length % 2 ? views[mid] : (views[mid - 1] + views[mid]) / 2;
  if (!median) return items;
  return items.map((i) => (i.views != null && i.views > 0 ? { ...i, outlier: Math.round((i.views / median) * 10) / 10 } : i));
}
