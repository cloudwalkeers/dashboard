// Build the dashboard payload from the reels already in Supabase, so the overview
// shows the REAL catalogue (with whatever metrics we have) instead of demo data
// when the live Graph API isn't available. Reuses transform.toPayload so the shape
// (and rate math) matches the live path exactly.
import { getDb, isConfigured } from "./supabase.mjs";
import { toPayload } from "../transform.mjs";

export { isConfigured };

export async function storedPayload({ account = null } = {}) {
  const db = await getDb();
  let q = db
    .from("reels")
    .select("shortcode,ig_account,permalink,published_at,caption,transcript_text,duration_sec,reel_metrics(likes,comments,plays,reach,saves,shares,avg_watch_sec,captured_date),reel_frames(img,t)")
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
  const thumbByShort = {};
  for (const r of reels) {
    const fr = (r.reel_frames || []).slice().sort((a, b) => Number(a.t) - Number(b.t))[0];
    if (fr && fr.img) thumbByShort[r.shortcode] = "/analysis/" + fr.img;
  }
  payload.defs.forEach((d) => { if (thumbByShort[d.id]) d.thumb = thumbByShort[d.id]; });
  return payload;
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
    if (fr && fr.img) out[r.shortcode] = "/analysis/" + fr.img;
  }
  return out;
}
