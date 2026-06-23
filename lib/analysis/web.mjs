// Extraction triggered from a pasted Instagram reel URL (the Content Creation
// tab / POST /api/extract). Parses the URL, grabs light metadata, runs the
// pipeline (which downloads via yt-dlp, extracts, and stores to Supabase —
// returning the cached row instantly if it's already been done).
import { parseReelUrl, reelMeta } from "./download.mjs";
import { analyzeReel } from "./analyze.mjs";

export async function analyzeFromUrl(url, { intervalSec = 2, force = false, onStep = () => {} } = {}) {
  const { account, shortcode } = parseReelUrl(url);
  let meta = {};
  if (!force) {
    /* metadata is cheap; only fetch when we might actually extract */
  }
  meta = await reelMeta(url);

  const { result, cached } = await analyzeReel({
    video: url,
    id: shortcode || undefined,
    force,
    intervalSec,
    account: account || meta.account || null,
    publishedAt: meta.publishedAt || null,
    permalink: url,
    metrics: { cap: meta.caption || "" },
    onStep,
  });
  return { ...result, cached: !!cached };
}
