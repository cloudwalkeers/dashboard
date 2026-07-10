// Trending-lane orchestrator. Sweeps a shared, curated set of creators through the
// vendor API, stores each reel with a per-sweep snapshot, and derives the signals that
// answer "what content is outperforming right now":
//   • outlier   = views ÷ the creator's OWN median (normalizes for account size)
//   • velocity  = views gained per hour since the last snapshot (the "trending" signal)
//   • engagement= (likes + comments) ÷ views (did people actually care?)
// It also clusters outliers by audio (an emerging sound multiple creators are riding)
// and rolls performance up by duration format. The result is a filterable feed of
// content recommendations, not a static list.
import { vendorConfigured, vendorUser, vendorUserClips, vendorSearchAccounts, vendorRelated, median } from "./vendorDiscovery.mjs";
import * as store from "./store/watchlist.mjs";
import { getCached, putCached } from "./store/hashtagCache.mjs";
import { getDb } from "./store/supabase.mjs";
import { currentIgAccount } from "./scope.mjs";

export { vendorConfigured };
export const isConfigured = store.isConfigured;

const HOUR_MS = 3600 * 1000;
const round = (n, d = 2) => (n == null || isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Turn one creator's freshly-fetched clips into DB rows with derived metrics. The
 *  outlier baseline (median) blends the fresh page with the reels ALREADY stored for
 *  this creator — history is reused from Supabase, never re-scraped. */
async function metricRows(username, igUserId, clips) {
  const now = new Date().toISOString();
  const stored = await store.creatorReelViews(username).catch(() => []);
  const freshCodes = new Set(clips.map((c) => c.shortcode));
  const baseline = clips.map((c) => ({ views: c.views, taken_at: c.publishedAt }))
    .concat(stored.filter((r) => !freshCodes.has(r.shortcode)).map((r) => ({ views: r.views, taken_at: r.taken_at })))
    .sort((a, b) => (Date.parse(b.taken_at || 0) || 0) - (Date.parse(a.taken_at || 0) || 0))
    .slice(0, 24);   // the creator's "normal" = their last ~24 reels
  const med = median(baseline.map((b) => b.views));
  const prev = await store.existingReels(clips.map((c) => c.shortcode));

  const rows = clips.map((c) => {
    const p = prev.get(c.shortcode) || null;
    const views = c.views ?? null;

    // velocity: Δviews ÷ Δhours vs the last snapshot; before we have one, bootstrap
    // from lifetime rate (views ÷ hours since posted) so the first sweep is useful.
    let velocity = null;
    if (views != null) {
      if (p && p.views != null && p.captured_at) {
        const dh = (Date.parse(now) - Date.parse(p.captured_at)) / HOUR_MS;
        if (dh > 0.05) velocity = Math.max(0, (views - p.views) / dh);
      } else if (c.publishedAt) {
        const ageH = (Date.parse(now) - Date.parse(c.publishedAt)) / HOUR_MS;
        if (ageH > 0.5) velocity = views / ageH;
      }
    }

    const eng = views && views > 0 ? ((c.likes || 0) + (c.comments || 0)) / views : null;

    return {
      shortcode: c.shortcode,
      creator_username: username,
      ig_user_id: igUserId ? String(igUserId) : (c.igUserId || null),
      permalink: c.permalink || null,
      caption: c.caption || null,
      thumbnail_url: c.thumbnail || null,
      media_type: c.media_type || null,
      duration_sec: c.durationSec ?? null,
      audio_id: c.audioId || null,
      audio_title: c.audioTitle || null,
      audio_artist: c.audioArtist || null,
      is_collab: !!c.isCollab,
      taken_at: c.publishedAt || null,
      views,
      like_count: c.likes ?? null,
      comment_count: c.comments ?? null,
      captured_at: now,
      prev_views: p ? p.views : null,
      prev_captured_at: p ? p.captured_at : null,
      outlier: med && views != null ? round(views / med, 2) : null,
      velocity: velocity == null ? null : round(velocity, 1),
      engagement: round(eng, 4),
      first_seen_at: p && p.first_seen_at ? p.first_seen_at : now,
      last_seen_at: now,
    };
  });
  return { rows, med };
}

/** Sweep one creator: resolve (if needed) → fetch clips → derive → persist.
 *  pages=1 is the routine sweep (fresh counts + new posts, 1 request); pages>1 is
 *  the one-time deep backfill (~12 reels per page). */
export async function sweepCreator(creator, { pages = 1 } = {}) {
  const username = (typeof creator === "string" ? creator : creator.username).replace(/^@/, "").toLowerCase();
  let igUserId = typeof creator === "object" ? creator.ig_user_id : null;
  try {
    if (!igUserId) {
      const u = await vendorUser(username);
      igUserId = u.igUserId;
      await store.addCreator({ username, igUserId, fullName: u.fullName, followerCount: u.followerCount, avatar: u.avatar });
    }
    const clips = await vendorUserClips(igUserId, { pages });
    if (!clips.length) { await store.markSwept(username, { error: "no reels returned", backfilled: pages > 1 }); return { username, reels: 0 }; }
    const { rows, med } = await metricRows(username, igUserId, clips);
    await store.saveReels(rows);
    await store.markSwept(username, { medianViews: med, backfilled: pages > 1 });
    return { username, reels: rows.length, median: med };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    await store.markSwept(username, { error: msg }).catch(() => {});
    return { username, reels: 0, error: msg };
  }
}

/** Sweep the whole active watchlist, sequentially (gentle on the vendor). Creators
 *  never deep-scraped get their one-time 3-page backfill here; everyone else costs
 *  exactly 1 request (history is reused from Supabase). */
export async function sweepAll({ onStep = () => {} } = {}) {
  const creators = await store.listCreators({ activeOnly: true });
  const results = [];
  let i = 0;
  for (const c of creators) {
    onStep(`sweep ${++i}/${creators.length} @${c.username}`);
    results.push(await sweepCreator(c, { pages: c.backfilled_at ? 1 : 3 }));
  }
  const reels = results.reduce((s, r) => s + (r.reels || 0), 0);
  return { creators: creators.length, reels, results };
}

/** Add a creator to this tenant's watchlist and sweep them immediately. When the
 *  caller already has the account's id (e.g. picked from search), pass igUserId to
 *  skip the flaky handle-resolution step entirely. */
export async function addAndSweep(username, { region = null, igUserId = null, fullName = null, followerCount = null, avatar = null } = {}) {
  let prof;
  if (igUserId) {
    prof = { igUserId: String(igUserId), username: String(username).replace(/^@/, "").toLowerCase(), fullName, followerCount, avatar };
  } else {
    prof = await vendorUser(username);
  }
  await store.addCreator({ username: prof.username, igUserId: prof.igUserId, fullName: prof.fullName, followerCount: prof.followerCount, avatar: prof.avatar, region });
  // first sweep goes deep (3 pages ≈ 36 reels) so discovery starts with real history
  const swept = await sweepCreator({ username: prof.username, ig_user_id: prof.igUserId }, { pages: 3 });
  return { creator: prof, swept };
}

/** On-demand: look up any account's last reels with in-batch outlier scores, WITHOUT
 *  adding them to the watchlist. Accepts a handle string or { username, igUserId }
 *  (the latter skips resolution). Powers "check a specific influencer." */
export async function lookupCreator(target, { amount = 12 } = {}) {
  const username = typeof target === "string" ? target : target.username;
  let igUserId = typeof target === "object" && target ? target.igUserId : null;
  let u;
  if (igUserId) {
    u = { username: String(username || "").replace(/^@/, "").toLowerCase(), igUserId: String(igUserId), followerCount: (typeof target === "object" && target.followerCount) || null };
  } else {
    u = await vendorUser(username);
    igUserId = u.igUserId;
  }
  const clips = await vendorUserClips(igUserId, { amount });
  const med = median(clips.map((c) => c.views));
  const reels = clips.map((c) => ({
    ...c,
    outlier: med && c.views != null ? round(c.views / med, 2) : null,
    engagement: c.views && c.views > 0 ? round(((c.likes || 0) + (c.comments || 0)) / c.views, 4) : null,
  })).sort((a, b) => (b.views || 0) - (a.views || 0));
  return { creator: u, median: med, reels };
}

/** Type-ahead account search (passthrough to the vendor). */
export async function searchAccounts(query, opts) {
  return vendorSearchAccounts(query, opts);
}

/** "Creators like @X": resolve the seed (or use a given id) → suggested profiles,
 *  flagged with whether they're already on this tenant's watchlist. */
export async function relatedCreators(target, { limit = 9 } = {}) {
  const username = typeof target === "string" ? target : target.username;
  let igUserId = typeof target === "object" && target ? target.igUserId : null;
  let seed;
  if (igUserId) {
    seed = { username: String(username || "").replace(/^@/, "").toLowerCase(), igUserId: String(igUserId) };
  } else {
    seed = await vendorUser(username);
    igUserId = seed.igUserId;
  }
  const suggestions = await vendorRelated(igUserId, { limit });
  const watched = new Set((await store.listCreators()).map((c) => c.username));
  return { seed, suggestions: suggestions.map((s) => ({ ...s, watched: watched.has((s.username || "").toLowerCase()) })) };
}

// Related-profiles calls, cached 6h in the shared discovery cache so re-opening the
// recommendations page doesn't re-burn the vendor for the same seed creators.
const REL_FRESH_MS = 6 * 3600 * 1000;
async function relatedCached(igUserId, limit) {
  const key = "rel:" + igUserId;
  const c = await getCached(key, "related").catch(() => null);
  if (c && Date.now() - Date.parse(c.fetched_at) < REL_FRESH_MS) return c.results || [];
  const sug = await vendorRelated(igUserId, { limit });
  putCached(key, "related", null, sug).catch(() => {});
  return sug;
}

/** Recommend creators in the tenant's niche WITHOUT manual picking: fan out related
 *  profiles from their best-performing watched creators, then rank candidates by how
 *  many of those seeds converge on the same person (multi-seed overlap = strong niche
 *  fit — "find the next mavgpt"). Cheap: a handful of related calls, all cached 6h;
 *  no reels are fetched. */
export async function recommendCreators({ maxSeeds = 4, perSeed = 15, limit = 24 } = {}) {
  const seeds = await store.seedCreators(maxSeeds);
  if (!seeds.length) return { seeds: [], recommendations: [], note: "Add a few creators you rate to your watchlist first — recommendations grow from those." };
  const watched = new Set((await store.listCreators()).map((c) => c.username));
  const agg = new Map();
  for (const seed of seeds) {
    if (!seed.ig_user_id) continue;
    let sug;
    try { sug = await relatedCached(seed.ig_user_id, perSeed); } catch { continue; }
    for (const s of sug) {
      if (!s.username || watched.has(s.username)) continue;
      const g = agg.get(s.username) || { igUserId: s.igUserId, username: s.username, fullName: s.fullName, avatar: s.avatar, isVerified: s.isVerified, followerCount: s.followerCount, from: new Set() };
      g.from.add(seed.username);
      if (!g.avatar && s.avatar) g.avatar = s.avatar;
      agg.set(s.username, g);
    }
  }
  const recommendations = [...agg.values()]
    .map((g) => ({ igUserId: g.igUserId, username: g.username, fullName: g.fullName, avatar: g.avatar, isVerified: g.isVerified, followerCount: g.followerCount, from: [...g.from], seedCount: g.from.size }))
    .sort((a, b) => b.seedCount - a.seedCount || (b.followerCount || 0) - (a.followerCount || 0))
    .slice(0, limit);
  return { seeds: seeds.map((s) => s.username), recommendations };
}

// ── Recommendations feed ──────────────────────────────────────────────────────

/** Cluster outlier reels by shared audio — an emerging sound ≥N creators are riding. */
async function audioClusters({ minOutlier = 1.5, minCreators = 2 } = {}) {
  const rows = await store.outlierReels(minOutlier);
  const byAudio = new Map();
  for (const r of rows) {
    const g = byAudio.get(r.audio_id) || { audio_id: r.audio_id, title: null, artist: null, reels: [], creators: new Set() };
    g.title = g.title || r.audio_title;
    g.artist = g.artist || r.audio_artist;
    g.reels.push(r);
    g.creators.add(r.creator_username);
    byAudio.set(r.audio_id, g);
  }
  return [...byAudio.values()]
    .filter((g) => g.creators.size >= minCreators)
    .map((g) => ({
      audioId: g.audio_id,
      title: g.title || "Original audio",
      artist: g.artist || null,
      creatorCount: g.creators.size,
      reelCount: g.reels.length,
      totalViews: g.reels.reduce((s, r) => s + (r.views || 0), 0),
      sampleThumb: (g.reels.find((r) => r.thumbnail_url) || {}).thumbnail_url || null,
      topPermalink: (g.reels[0] || {}).permalink || null,
    }))
    .sort((a, b) => b.creatorCount - a.creatorCount || b.totalViews - a.totalViews);
}

/** Median outlier/engagement/velocity per duration format, so we can say which
 *  length is currently overperforming across the watched set. */
async function formatBuckets() {
  const rows = await store.allReelsLite();
  const defs = [
    { key: "short", label: "< 12s", lo: 0, hi: 12 },
    { key: "mid", label: "12–30s", lo: 12, hi: 30 },
    { key: "long", label: "30–60s", lo: 30, hi: 60 },
    { key: "xlong", label: "60s+", lo: 60, hi: 1e9 },
  ];
  return defs.map((d) => {
    const inB = rows.filter((r) => r.duration_sec != null && r.duration_sec >= d.lo && r.duration_sec < d.hi);
    return {
      key: d.key,
      label: d.label,
      count: inB.length,
      medOutlier: round(median(inB.map((r) => r.outlier)), 2),
      medEngagement: round(median(inB.map((r) => r.engagement)), 4),
      medVelocity: round(median(inB.map((r) => r.velocity)), 1),
    };
  }).filter((b) => b.count > 0);
}

// ── Niche-fit feed: "best videos that correspond to the content I make" ───────
// Score every watched reel against the tenant's OWN content (transcripts+captions
// already in Supabase), then rank by content-match × outlier (capped) × freshness.
// Raw outlier alone surfaces stale one-offs and off-niche brand campaigns; this
// sinks them without any manual filtering. Deterministic — no LLM, no vendor calls.
const STOP = new Set(("the and for you your with this that from have will was were are but not can what when how why all out get got just like more most very them they their who its it's im i'm ich und der die das den dem des ein eine einen einem einer mit für nicht auch auf aus bei von zu zum zur ist sind war hat habe haben wird werden kann kannst könnt ihr wir uns euch dir dich mir mich man wenn dann doch noch nur so wie was wer wo da hier mal schon sehr viel mehr oder aber als bis durch gegen ohne um unter über vor nach seit zwischen dieser diese dieses jetzt heute comment kommentier kommentiere kommentiert send sende link dm folge follow share teile save speichern ill i'll over guide guides full free new").split(/\s+/));
const SYN = { ki: "ai", "künstliche": "ai", intelligenz: "ai", werkzeug: "tool", werkzeuge: "tools" };
const tokenize = (t) => String(t || "").toLowerCase().replace(/[#@]/g, " ").split(/[^a-z0-9äöüß+']+/)
  .map((w) => SYN[w] || w).filter((w) => w.length >= 3 && !STOP.has(w));

/** Term-frequency fingerprint of the tenant's own published content. */
async function contentProfile() {
  const db = await getDb();
  const acct = currentIgAccount();
  let q = db.from("reels").select("caption,transcript_text").not("transcript_text", "is", null);
  if (acct) q = q.eq("ig_account", acct);
  const { data } = await q;
  const freq = new Map();
  for (const r of data || []) for (const w of tokenize((r.caption || "") + " " + (r.transcript_text || ""))) freq.set(w, (freq.get(w) || 0) + 1);
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
  const max = top.length ? top[0][1] : 1;
  return new Map(top.map(([w, c]) => [w, 0.3 + 0.7 * (c / max)]));   // weight 0.3..1 per term
}

/** The personalized feed: watched reels ranked by fit-to-your-content. */
export async function nicheFeed({ limit = 40 } = {}) {
  const [profile, reels] = await Promise.all([contentProfile(), store.leaderboard({ sort: "outlier", limit: 200 })]);
  const now = Date.now();
  const scored = [];
  for (const r of reels) {
    if (r.views != null && r.views < 3000) continue;   // micro-account noise can't be an insight
    const toks = new Set(tokenize(r.caption || ""));
    const matched = [];
    let rel = 0;
    for (const t of toks) if (profile.has(t)) { matched.push(t); rel += profile.get(t); }
    rel = Math.min(rel, 3);
    matched.sort((a, b) => (profile.get(b) || 0) - (profile.get(a) || 0));
    const ageDays = r.taken_at ? (now - Date.parse(r.taken_at)) / 86400000 : 365;
    const fresh = Math.exp(-ageDays / 60);             // ~2-month half-life: stale can't dominate
    const out = Math.min(r.outlier || 0.5, 10);        // cap: one 75× fluke shouldn't own the page
    const score = (profile.size ? 0.35 + rel : 1) * out * (0.15 + fresh);
    scored.push({ ...r, match_terms: matched.slice(0, 3), _s: score });
  }
  scored.sort((a, b) => b._s - a._s);
  const top = scored.slice(0, limit);
  const max = top.length ? top[0]._s : 1;
  for (const t of top) { t.match = Math.max(1, Math.round((t._s / max) * 100)); delete t._s; }
  return { items: top, personalized: profile.size > 0 };
}

/** The whole Trending surface for the frontend: ranked+filtered reels, audio
 *  clusters, format rollup, and a small header of watchlist stats. */
export async function getFeed(filters = {}) {
  const [items, clusters, formats, creators] = await Promise.all([
    store.leaderboard(filters),
    audioClusters(),
    formatBuckets(),
    store.listCreators(),
  ]);
  const swept = creators.filter((c) => c.last_swept_at);
  const lastSweep = swept.map((c) => Date.parse(c.last_swept_at)).sort((a, b) => b - a)[0] || null;
  return {
    items,
    clusters,
    formats,
    stats: {
      creators: creators.length,
      swept: swept.length,
      lastSweep: lastSweep ? new Date(lastSweep).toISOString() : null,
    },
  };
}
