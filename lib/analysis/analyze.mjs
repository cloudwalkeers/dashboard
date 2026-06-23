// Orchestrates the per-reel pipeline:
//   video → frames + audio → categorized frame analysis (OpenAI vision) →
//   spoken transcript (Whisper if available, else stitched from the burned-in
//   captions) → analysis (OpenAI) → analysis/<id>.json
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { extractFramesAndAudio } from "./frames.mjs";
import { transcribe } from "./transcribe.mjs";
import { describeFrames } from "./vision.mjs";
import { runAnalysis } from "./reason.mjs";
import { downloadReel } from "./download.mjs";
import { isConfigured as supaConfigured, storeAnalysis, getStoredReel } from "../store/supabase.mjs";

// Save the result into Supabase (best-effort, non-fatal) — skipped on dry runs,
// when Supabase isn't configured, or when store === false.
async function persist(result, { store, dryRun, account, publishedAt, permalink, onStep }) {
  if (store === false || dryRun || !supaConfigured()) return;
  try {
    onStep("store");
    await storeAnalysis(result, { account, publishedAt, permalink });
  } catch (e) {
    onStep("store failed: " + (e && e.message ? e.message : e));
  }
}

// Fallback transcript stitched from the on-screen subtitle (the `text` element
// whose role is a subtitle) — only used when Whisper audio is unavailable.
const subtitleOf = (f) => {
  const s = (f.text || []).find((t) => /subtitle|caption|untertitel/i.test(t.role || ""));
  return ((s && s.content) || "").trim();
};
function captionTranscript(items) {
  const segs = [];
  let last = null;
  for (const f of items) {
    const c = subtitleOf(f);
    if (!c) { last = null; continue; }
    if (last && c === last.text) { last.end = f.t; continue; }
    last = { start: f.t, end: f.t, text: c };
    segs.push(last);
  }
  return segs;
}

// Prefer a real ASR transcript; fall back to the creator's burned-in captions
// (ground truth for a fully-subtitled reel, and no audio-model access needed).
function chooseTranscript(whisper, items) {
  if (whisper && whisper.segments && whisper.segments.length) return whisper;
  const segments = captionTranscript(items);
  if (segments.length)
    return { segments, text: segments.map((s) => s.text).join(" "), lang: (whisper && whisper.lang) || "", source: "captions (burned-in subtitles)" };
  return whisper || { segments: [], text: "", lang: "", source: "unavailable" };
}

const frameOut = (id, items, files) =>
  items.map((f, i) => ({
    t: f.t,
    img: files ? path.posix.join(id, "frames", path.basename(files[i].file)) : f.img,
    visual: f.visual,
    motion: f.motion,
    text: f.text || [],
  }));

export async function analyzeReel({ id, video, metrics = {}, retention = [], outRoot, dryRun = false, intervalSec = 2, reuse = false, store = true, cache = true, force = false, account = null, publishedAt = null, permalink = null, onStep = () => {} }) {
  if (!id) id = (video || "reel").split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, "") || "reel";
  outRoot = outRoot || path.join(process.cwd(), "analysis");
  const workDir = path.join(outRoot, id);
  await mkdir(workDir, { recursive: true });
  const prevPath = path.join(outRoot, id + ".json");

  // Already extracted and stored in Supabase? Return it and skip the paid
  // OpenAI pass entirely (unless --reuse or --force).
  if (!reuse && !force && cache && supaConfigured()) {
    try {
      const stored = await getStoredReel(id);
      if (stored) {
        onStep("cached (supabase)");
        return { result: stored, jsonPath: prevPath, cached: true };
      }
    } catch { /* not cached / lookup failed — fall through and extract */ }
  }

  // --reuse: keep the (paid) frame analysis, only redo transcript + analysis.
  if (reuse && existsSync(prevPath)) {
    const prev = JSON.parse(readFileSync(prevPath, "utf8"));
    const dur = prev.video?.durationSec || 0;
    const audioPath = path.join(workDir, "audio.wav");
    const items = (prev.frames || []).map((f) => ({ t: f.t, visual: f.visual, motion: f.motion, text: f.text || [] }));
    onStep("transcribe");
    const whisper = await transcribe(existsSync(audioPath) ? audioPath : null, { dryRun, durationSec: dur });
    const transcript = chooseTranscript(whisper, items);
    onStep("analyze");
    const analysis = await runAnalysis({
      metrics: Object.keys(metrics).length ? metrics : prev.metrics || {},
      retention: retention.length ? retention : prev.retention || [],
      transcript, frames: items, durationSec: dur, dryRun,
    });
    const result = {
      ...prev,
      transcript,
      analysis: analysis.result,
      meta: { ...prev.meta, createdAt: Date.now(), models: { ...prev.meta.models, analysis: dryRun ? null : analysis.model, transcript: transcript.source }, costUsd: +(analysis.costUsd || 0).toFixed(4) },
    };
    await writeFile(prevPath, JSON.stringify(result, null, 2));
    await persist(result, { store, dryRun, account, publishedAt, permalink, onStep });
    return { result, jsonPath: prevPath };
  }

  let videoPath = video;
  let downloaded = false;
  if (/^https?:/i.test(video)) {
    onStep("download");
    videoPath = path.join(workDir, "reel.mp4");
    await downloadReel(video, videoPath);
    downloaded = true;
  }

  onStep("frames");
  const { frames, audioPath, durationSec } = await extractFramesAndAudio(videoPath, workDir, { intervalSec });

  onStep("vision");
  const vision = await describeFrames(frames, { dryRun, caption: metrics.cap || metrics.caption || "", onStep });

  onStep("transcribe");
  const whisper = await transcribe(audioPath, { dryRun, durationSec });
  const transcript = chooseTranscript(whisper, vision.items);

  onStep("analyze");
  const analysis = await runAnalysis({ metrics, retention, transcript, frames: vision.items, durationSec, dryRun });

  const result = {
    id,
    source: downloaded ? "live" : "local",
    video: { src: downloaded ? video : path.resolve(videoPath), durationSec, frameCount: frames.length, intervalSec },
    frames: frameOut(id, vision.items, frames),
    transcript,
    metrics,
    retention,
    analysis: analysis.result,
    meta: {
      createdAt: Date.now(),
      dryRun,
      models: {
        vision: dryRun ? null : vision.model,
        analysis: dryRun ? null : analysis.model,
        transcript: transcript.source,
      },
      costUsd: +((vision.costUsd || 0) + (analysis.costUsd || 0)).toFixed(4),
    },
  };

  const jsonPath = path.join(outRoot, id + ".json");
  await writeFile(jsonPath, JSON.stringify(result, null, 2));
  await persist(result, { store, dryRun, account, publishedAt, permalink, onStep });
  return { result, jsonPath };
}
