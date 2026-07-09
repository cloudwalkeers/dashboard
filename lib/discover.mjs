// Reels discovery orchestrator: find inspiration reels by hashtag (Instagram
// Graph API) or by pasted links (token-free yt-dlp stats), normalize, and store
// them in the discovery library with a category.
import { searchHashtag, hashtagMedia, discoveryConfigured } from "./graph.mjs";
import { reelStats, parseReelUrl } from "./analysis/download.mjs";
import { saveDiscovered } from "./store/discovery.mjs";
import { getCached, putCached, quotaState } from "./store/hashtagCache.mjs";
import { vendorConfigured, vendorHashtag, scoreOutliers } from "./vendorDiscovery.mjs";

const shortcodeOf = (permalink) => {
  const m = String(permalink || "").match(/\/(?:reel|reels|p|tv)\/([^/?#]+)/i);
  return m ? m[1] : null;
};

// A cached hashtag is served without touching Instagram for this long.
const CACHE_FRESH_MS = 6 * 3600 * 1000;

/** Hashtag discovery — multi-tenant by design. Hashtag results are PUBLIC content
 *  (identical for every caller), so one platform token (IG_DISCOVERY_TOKEN, a
 *  Business/Facebook-login token — creators' Instagram-login tokens can't call this
 *  API) serves every client through a shared cache: the first search in a window
 *  hits Instagram, everyone after gets it instantly, and Meta's 30-unique-hashtags
 *  per rolling week budget is guarded. Each creator's finds still land on their
 *  OWN board (saveDiscovered is tenant-scoped). */
export async function discoverByHashtag(tag, { type = "top", category = null } = {}) {
  const clean = String(tag).replace(/^#/, "").trim().toLowerCase();
  if (!clean) return [];

  // ── Vendor lane (preferred when configured): view counts + outlier scores,
  //    effectively unlimited — cached 6h per tag so repeat searches cost nothing.
  if (vendorConfigured()) {
    const vtype = "v:" + type;
    const vc = await getCached(clean, vtype).catch(() => null);
    let items;
    if (vc && Date.now() - Date.parse(vc.fetched_at) < CACHE_FRESH_MS) {
      items = vc.results || [];
    } else {
      items = await vendorHashtag(clean, { type });
      items = scoreOutliers(items);
      putCached(clean, vtype, null, items).catch(() => {});
    }
    return saveDiscovered(items, { category, hashtag: clean, source: "hashtag" });
  }

  // ── Official-API lane (fallback): no view counts, 30-unique-tags/week budget.
  const cache = await getCached(clean, type).catch(() => null);
  const fresh = cache && Date.now() - Date.parse(cache.fetched_at) < CACHE_FRESH_MS;

  let media = null;
  if (fresh) {
    media = cache.results || [];
  } else {
    if (!discoveryConfigured()) {
      if (cache) media = cache.results || []; // stale beats nothing
      else {
        const e = new Error("Hashtag search isn't switched on for this workspace yet — add HIKERAPI_KEY (recommended: view counts + outlier scores) or IG_DISCOVERY_TOKEN + IG_DISCOVERY_USER_ID on the server. Pasting reel links below always works.");
        e.code = "NO_CREDS";
        throw e;
      }
    } else {
      const q = await quotaState(clean).catch(() => ({ used: 0, guard: 28, hasTag: false }));
      if (!q.hasTag && q.used >= q.guard && cache) {
        media = cache.results || []; // budget nearly spent → serve the stale copy
      } else if (!q.hasTag && q.used >= q.guard) {
        const e = new Error(`This week's shared hashtag budget is nearly used up (Instagram allows ${q.limit || 30} unique hashtags per rolling week platform-wide). Recently searched hashtags still work instantly — or paste reel links, which are unlimited.`);
        e.code = "QUOTA";
        throw e;
      } else {
        const id = (cache && cache.hashtag_id) || (await searchHashtag(clean));
        if (!id) return [];
        media = await hashtagMedia(id, { type });
        putCached(clean, type, id, media).catch(() => {});
      }
    }
  }

  const items = (media || [])
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
  return saveDiscovered(items, { category, hashtag: clean, source: "hashtag" });
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
