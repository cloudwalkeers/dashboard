// Build the dashboard payload from the reels already in Supabase, so the overview
// shows the REAL catalogue (with whatever metrics we have) instead of demo data
// when the live Graph API isn't available. Reuses transform.toPayload so the shape
// (and rate math) matches the live path exactly.
import { existsSync } from "node:fs";
import path from "node:path";
import { getDb, isConfigured } from "./supabase.mjs";
import { toPayload } from "../transform.mjs";

export { isConfigured };

// Cover persisted by the live sync (analysis/thumbs/<shortcode>.jpg) — the reliable
// fallback when a reel has no extracted frames on this machine/volume.
const savedThumb = (sc) =>
  existsSync(path.join(process.cwd(), "analysis", "thumbs", sc + ".jpg")) ? "/analysis/thumbs/" + sc + ".jpg" : null;

export async function storedPayload({ account = null } = {}) {
  const db = await getDb();
  let q = db
    .from("reels")
    .select("shortcode,ig_account,permalink,published_at,caption,transcript_text,duration_sec,retention_curve,skip_rate,repost_rate,rate_benchmarks,reel_metrics(likes,comments,plays,reach,saves,shares,avg_watch_sec,captured_date),reel_frames(img,t)")
    .order("published_at", { ascending: false, nullsFirst: false });
  if (account) q = q.eq("ig_account", account);
  const { data, error } = await q;
  if (error) throw new Error("storedPayload: " + error.message);
  const reels = (data || []).filter((r) => r.shortcode);
  if (!reels.length) return null;

  // The stored caption is often just yt-dlp's "Video by …" — prefer the spoken
  // hook (first line of the transcript) so reels are recognizable in the table.
  const generic = (c) => !c || /^video by /i.test(c) || /^untitled/i.test(c);
  const firstLine = (t) => {
    const s = String(t || "").trim().split(/[.!?\n]/)[0].trim();
    return s.length > 70 ? s.slice(0, 68).trimEnd() + "…" : s;
  };

  const items = reels.map((r) => {
    const m = (r.reel_metrics || []).slice().sort((a, b) => String(b.captured_date).localeCompare(String(a.captured_date)))[0] || {};
    const views = m.plays ?? null;
    return {
      media: {
        id: r.shortcode, // detail view loads analysis/<id>.json by this id
        caption: generic(r.caption) ? (firstLine(r.transcript_text) || r.caption || r.shortcode) : r.caption,
        permalink: r.permalink || "https://www.instagram.com/reel/" + r.shortcode + "/",
        timestamp: r.published_at,
        media_product_type: "REELS",
        like_count: m.likes ?? 0,
        comments_count: m.comments ?? 0,
      },
      insights: {
        views: views ?? 0,
        reach: m.reach ?? views ?? 0, // reach unknown token-free → use views as the base
        likes: m.likes ?? 0,
        comments: m.comments ?? 0,
        saved: m.saves ?? 0,
        shares: m.shares ?? 0,
        ig_reels_avg_watch_time: m.avg_watch_sec ? m.avg_watch_sec * 1000 : 0,
      },
      len: r.duration_sec || null,
      lenKnown: !!r.duration_sec,
    };
  });

  const acct = reels[0].ig_account;
  const payload = toPayload({ items, trend: null, profile: acct ? { username: acct } : null }, { source: "supabase" });
  // Real cover image = the reel's first extracted frame (served from /analysis).
  const thumbByShort = {}, retByShort = {}, rateByShort = {};
  for (const r of reels) {
    const fr = (r.reel_frames || []).slice().sort((a, b) => Number(a.t) - Number(b.t))[0];
    // Prefer an extracted frame ONLY if it exists on this machine/volume; otherwise
    // the cover the sync persisted. (Frame files live where extraction ran — on a
    // fresh server they don't exist and would render as broken images.)
    if (fr && fr.img && existsSync(path.join(process.cwd(), "analysis", fr.img))) thumbByShort[r.shortcode] = "/analysis/" + fr.img;
    else { const t = savedThumb(r.shortcode); if (t) thumbByShort[r.shortcode] = t; }
    if (Array.isArray(r.retention_curve) && r.retention_curve.length) retByShort[r.shortcode] = r.retention_curve;
    if (r.skip_rate != null || r.repost_rate != null || r.rate_benchmarks) rateByShort[r.shortcode] = { skip: r.skip_rate, repost: r.repost_rate, bench: r.rate_benchmarks };
  }
  payload.defs.forEach((d) => {
    if (thumbByShort[d.id]) d.thumb = thumbByShort[d.id];
    if (retByShort[d.id]) d.retentionCurve = retByShort[d.id]; // real audience retention from insights recordings
    if (rateByShort[d.id]) { const x = rateByShort[d.id]; d.skipRate = x.skip; d.repostRate = x.repost; d.rateBenchmarks = x.bench; } // real Skip/Repost + Higher/Lower
  });
  return payload;
}

/** shortcode -> duration_sec, so the live refresh can skip the slow per-reel mp4
 *  probe (we already know every reel's length from extraction). */
export async function durationsByShortcode() {
  const db = await getDb();
  const { data } = await db.from("reels").select("shortcode,duration_sec").not("duration_sec", "is", null);
  const out = {};
  for (const r of data || []) if (r.shortcode) out[r.shortcode] = Number(r.duration_sec);
  return out;
}

/** shortcode -> {retention_curve, skip_rate, repost_rate, rate_benchmarks} from the
 *  insights recordings, so the live/Refresh path shows them too (not just stored). */
export async function retentionByShortcode(shortcodes = []) {
  const list = (shortcodes || []).filter(Boolean);
  if (!list.length) return {};
  const db = await getDb();
  const { data } = await db.from("reels").select("shortcode,retention_curve,skip_rate,repost_rate,rate_benchmarks").in("shortcode", list);
  const out = {};
  for (const r of data || []) {
    if (Array.isArray(r.retention_curve) || r.skip_rate != null || r.repost_rate != null) {
      out[r.shortcode] = { retention_curve: Array.isArray(r.retention_curve) ? r.retention_curve : null, skip_rate: r.skip_rate, repost_rate: r.repost_rate, rate_benchmarks: r.rate_benchmarks };
    }
  }
  return out;
}

/** First extracted frame per shortcode, served from /analysis — reliable local reel
 *  covers (the live Graph API gives CDN thumbnail URLs that can hotlink-block). */
export async function localThumbs(shortcodes = []) {
  const list = (shortcodes || []).filter(Boolean);
  if (!list.length) return {};
  const db = await getDb();
  const { data } = await db.from("reels").select("shortcode,reel_frames(img,t)").in("shortcode", list);
  const out = {};
  for (const r of data || []) {
    const fr = (r.reel_frames || []).slice().sort((a, b) => Number(a.t) - Number(b.t))[0];
    if (fr && fr.img && existsSync(path.join(process.cwd(), "analysis", fr.img))) out[r.shortcode] = "/analysis/" + fr.img;
    else { const t = savedThumb(r.shortcode); if (t) out[r.shortcode] = t; }
  }
  return out;
}
