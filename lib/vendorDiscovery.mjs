// Vendor-powered discovery (the "sandcastle" lane): a scraping-API provider gives us
// hashtag results WITH reel view counts — which the official API never exposes — so
// we can compute outlier scores. Provider-agnostic adapter; HikerAPI is the default
// (pay-per-request, ~$0.0006/call, no monthly minimum). One platform API key serves
// every client; results are public content and each creator's finds stay on their board.
const PROVIDER = () => (process.env.DISCOVERY_VENDOR || "hikerapi").toLowerCase();

export function vendorConfigured() {
  return !!process.env.HIKERAPI_KEY;
}

/** Search a hashtag through the vendor → normalized items (with views) or throws. */
export async function vendorHashtag(tag, { type = "top" } = {}) {
  if (PROVIDER() !== "hikerapi") throw new Error("Unknown DISCOVERY_VENDOR: " + PROVIDER());
  const key = process.env.HIKERAPI_KEY;
  const edge = type === "recent" ? "recent" : "top";
  const url = `https://api.hikerapi.com/v1/hashtag/medias/${edge}?name=${encodeURIComponent(String(tag).replace(/^#/, "").trim())}`;
  const res = await fetch(url, { headers: { "x-access-key": key, accept: "application/json" } });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (json && (json.detail || json.message || json.error)) || res.statusText;
    throw new Error(`Discovery vendor ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg).slice(0, 200)}`);
  }
  const list = Array.isArray(json) ? json : (json && (json.medias || json.items || json.data || json.results)) || [];
  return list.map(normalizeMedia).filter((m) => m && m.shortcode);
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
  const takenAt = m.taken_at_ts || m.taken_at || m.timestamp || null;
  const thumb = m.thumbnail_url
    || (m.image_versions2 && m.image_versions2.candidates && m.image_versions2.candidates[0] && m.image_versions2.candidates[0].url)
    || (Array.isArray(m.image_versions) && m.image_versions[0] && m.image_versions[0].url)
    || m.display_uri || m.display_url || null;
  const caption = (m.caption_text != null ? m.caption_text : (m.caption && (m.caption.text || m.caption)) || "") || "";
  return {
    shortcode,
    permalink: "https://www.instagram.com/reel/" + shortcode + "/",
    account: user.username || null,
    caption: String(caption).slice(0, 1000),
    thumbnail: thumb,
    media_type: m.media_type === 2 || m.product_type === "clips" ? "VIDEO" : (m.media_type === 8 ? "CAROUSEL_ALBUM" : m.media_type === 1 ? "IMAGE" : String(m.media_type || "")),
    likes, comments,
    views,
    publishedAt: takenAt ? new Date((Number(takenAt) < 2e10 ? Number(takenAt) * 1000 : Number(takenAt))).toISOString() : null,
    raw: { code: shortcode, play_count: views, username: user.username || null, product_type: m.product_type || null },
  };
}

function firstNum(...vals) {
  for (const v of vals) if (v != null && !isNaN(Number(v))) return Number(v);
  return null;
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
