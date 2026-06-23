// Persists an analysis result into the normalized Supabase schema, and reads it
// back (so a reel's "skeleton" is fetched from Supabase instead of re-extracted).
// Uses the service-role key — server-side only, never ship this to the browser.
import { SUPABASE_TABLES } from "./schema.mjs";

let _sb;

export function isConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function sb() {
  if (_sb) return _sb;
  if (!isConfigured()) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in .env");
  let createClient;
  try {
    ({ createClient } = await import("@supabase/supabase-js"));
  } catch {
    throw new Error("@supabase/supabase-js not installed. Run: npm install");
  }
  _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return _sb;
}

const childTables = SUPABASE_TABLES.children;

/** Upsert an analysis result (the shape written to analysis/<id>.json) + metadata. */
export async function storeAnalysis(result, { account = null, publishedAt = null, permalink = null } = {}) {
  const db = await sb();
  const a = result.analysis || {};

  const reelRow = {
    shortcode: result.id,
    caption: result.metrics?.cap || result.metrics?.caption || null,
    duration_sec: result.video?.durationSec ?? null,
    frame_count: result.video?.frameCount ?? null,
    interval_sec: result.video?.intervalSec ?? null,
    source: result.source || null,
    video_src: result.video?.src || null,
    transcript_text: result.transcript?.text || null,
    transcript_source: result.transcript?.source || null,
    transcript_lang: result.transcript?.lang || null,
    summary: a.summary || null,
    hook: a.hook || null,
    analysis_models: result.meta?.models || null,
    cost_usd: result.meta?.costUsd ?? null,
    extracted_at: result.meta?.createdAt ? new Date(result.meta.createdAt).toISOString() : new Date().toISOString(),
  };
  // Only set these when provided, so a metadata-less re-store doesn't wipe them.
  if (account) reelRow.ig_account = account;
  if (permalink) reelRow.permalink = permalink;
  if (publishedAt) reelRow.published_at = publishedAt;

  const { data: reel, error } = await db.from("reels").upsert(reelRow, { onConflict: "shortcode" }).select("id").single();
  if (error) throw new Error("reels upsert: " + error.message);
  const reelId = reel.id;

  // Idempotent re-store: clear the reel's child rows, then re-insert.
  for (const t of childTables) {
    const { error: delErr } = await db.from(t).delete().eq("reel_id", reelId);
    if (delErr) throw new Error(`${t} clear: ${delErr.message}`);
  }

  const frames = result.frames || [];
  if (frames.length) {
    const { data: insFrames, error: fErr } = await db
      .from("reel_frames")
      .insert(frames.map((f) => ({ reel_id: reelId, t: f.t, img: f.img, visual: f.visual, motion: f.motion })))
      .select("id, t");
    if (fErr) throw new Error("reel_frames insert: " + fErr.message);
    const idByT = new Map(insFrames.map((r) => [Number(r.t), r.id]));

    const textRows = [];
    for (const f of frames)
      for (const el of f.text || [])
        textRows.push({
          reel_id: reelId,
          frame_id: idByT.get(Number(f.t)),
          t: f.t,
          content: el.content,
          role: el.role,
          font: el.font,
          color: el.color,
          background: el.background,
          size: el.size,
          pos: el.position,
        });
    if (textRows.length) {
      const { error: tErr } = await db.from("reel_frame_text").insert(textRows);
      if (tErr) throw new Error("reel_frame_text insert: " + tErr.message);
    }
  }

  await insertRows(db, "reel_transcript_segments", (result.transcript?.segments || []).map((s, i) => ({ reel_id: reelId, idx: i, start_sec: s.start, end_sec: s.end, text: s.text })));
  await insertRows(db, "reel_dropoff", (a.dropoff || []).map((d) => ({ reel_id: reelId, t: d.t, why: d.why })));
  await insertRows(db, "reel_suggestions", (a.suggestions || []).map((s, i) => ({ reel_id: reelId, idx: i, text: s })));
  await insertRows(db, "reel_moments", (a.moments || []).map((m) => ({ reel_id: reelId, t: m.t, label: m.label })));

  return reelId;
}

async function insertRows(db, table, rows) {
  if (!rows.length) return;
  const { error } = await db.from(table).insert(rows);
  if (error) throw new Error(`${table} insert: ${error.message}`);
}

/** Rebuild the analysis-result shape from Supabase (used to skip re-extraction). */
export async function getStoredReel(shortcode) {
  const db = await sb();
  const { data: reel } = await db.from("reels").select("*").eq("shortcode", shortcode).maybeSingle();
  if (!reel) return null;

  const [frames, ftext, segs, dd, sg, mo] = await Promise.all([
    db.from("reel_frames").select("*").eq("reel_id", reel.id).order("t"),
    db.from("reel_frame_text").select("*").eq("reel_id", reel.id).order("t"),
    db.from("reel_transcript_segments").select("*").eq("reel_id", reel.id).order("idx"),
    db.from("reel_dropoff").select("*").eq("reel_id", reel.id).order("t"),
    db.from("reel_suggestions").select("*").eq("reel_id", reel.id).order("idx"),
    db.from("reel_moments").select("*").eq("reel_id", reel.id).order("t"),
  ]);

  const textByFrame = new Map();
  for (const x of ftext.data || []) {
    const arr = textByFrame.get(x.frame_id) || [];
    arr.push({ content: x.content, role: x.role, font: x.font, color: x.color, background: x.background, size: x.size, position: x.pos });
    textByFrame.set(x.frame_id, arr);
  }

  return {
    id: reel.shortcode,
    ig_account: reel.ig_account,
    published_at: reel.published_at,
    permalink: reel.permalink,
    source: reel.source,
    video: { src: reel.video_src, durationSec: Number(reel.duration_sec), frameCount: reel.frame_count, intervalSec: Number(reel.interval_sec) },
    frames: (frames.data || []).map((f) => ({ t: Number(f.t), img: f.img, visual: f.visual, motion: f.motion, text: textByFrame.get(f.id) || [] })),
    transcript: { segments: (segs.data || []).map((s) => ({ start: Number(s.start_sec), end: Number(s.end_sec), text: s.text })), text: reel.transcript_text || "", lang: reel.transcript_lang || "", source: reel.transcript_source || "" },
    metrics: {},
    retention: [],
    analysis: {
      summary: reel.summary || "",
      hook: reel.hook || "",
      dropoff: (dd.data || []).map((d) => ({ t: Number(d.t), why: d.why })),
      suggestions: (sg.data || []).map((s) => s.text),
      moments: (mo.data || []).map((m) => ({ t: Number(m.t), label: m.label })),
    },
    meta: { createdAt: reel.extracted_at ? Date.parse(reel.extracted_at) : null, models: reel.analysis_models, costUsd: Number(reel.cost_usd), fromStore: true },
  };
}
