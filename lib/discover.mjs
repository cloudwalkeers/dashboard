// Reels discovery orchestrator: find inspiration reels by hashtag (Instagram
// Graph API) or by pasted links (token-free yt-dlp stats), normalize, and store
// them in the discovery library with a category.
import { searchHashtag, hashtagMedia, discoveryConfigured } from "./graph.mjs";
import { reelStats, parseReelUrl } from "./analysis/download.mjs";
import { saveDiscovered } from "./store/discovery.mjs";

const shortcodeOf = (permalink) => {
  const m = String(permalink || "").match(/\/(?:reel|reels|p|tv)\/([^/?#]+)/i);
  return m ? m[1] : null;
};

/** Hashtag discovery via the Graph API. Instagram only exposes hashtag search on
 *  the Facebook-login Business API, NOT on creators' Instagram-login tokens — so
 *  this uses the platform's own IG_DISCOVERY_TOKEN/IG_DISCOVERY_USER_ID env creds. */
export async function discoverByHashtag(tag, { type = "top", category = null } = {}) {
  if (!discoveryConfigured()) {
    const e = new Error("Hashtag search isn't switched on for this workspace yet (it needs the platform's Business-API discovery token — set IG_DISCOVERY_TOKEN + IG_DISCOVERY_USER_ID on the server). Pasting reel links below always works.");
    e.code = "NO_CREDS";
    throw e;
  }
  const id = await searchHashtag(tag);
  const media = id ? await hashtagMedia(id, { type }) : [];
  if (!id) return [];
  const items = media
    .map((m) => ({
      shortcode: shortcodeOf(m.permalink),
      permalink: m.permalink,
      account: null, // hashtag media doesn't include the author handle
      caption: m.caption || "",
      thumbnail: m.thumbnail_url || m.media_url || null,
      media_type: m.media_type,
      likes: m.like_count ?? null,
      comments: m.comments_count ?? null,
      views: null, // not exposed by the hashtag API
      publishedAt: m.timestamp || null,
      raw: m,
    }))
    .filter((it) => it.shortcode);
  return saveDiscovered(items, { category, hashtag: String(tag).replace(/^#/, "").trim(), source: "hashtag" });
}

/** Token-free discovery from pasted reel links (public stats via yt-dlp). */
export async function discoverByLinks(urls, { category = null, onStep = () => {} } = {}) {
  const list = (Array.isArray(urls) ? urls : String(urls).split(/[\s,]+/))
    .map((s) => s.trim())
    .filter((s) => /instagram\.com/.test(s) || parseReelUrl(s).shortcode);
  const items = [];
  let i = 0;
  for (const url of list) {
    onStep(`stats ${++i}/${list.length}`);
    const s = await reelStats(url);
    if (s && s.shortcode) items.push(s);
  }
  return saveDiscovered(items, { category, source: "link" });
}
