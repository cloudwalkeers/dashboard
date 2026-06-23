// Frame + audio extraction via ffmpeg. Samples one frame every `intervalSec`,
// scaled down to keep vision-token cost in check, and pulls a 16 kHz mono WAV
// for whisper.cpp. Reuses the project's own mvhd parser for the duration.
import { mkdir, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ffmpegPath, run } from "./proc.mjs";
import { durationFromMp4Buffer } from "../mp4duration.mjs";

export async function extractFramesAndAudio(videoPath, workDir, { intervalSec = 2, width = 512 } = {}) {
  const bin = await ffmpegPath();
  const framesDir = path.join(workDir, "frames");
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  // One JPEG every intervalSec seconds, scaled to `width` (height kept even).
  await run(bin, [
    "-y", "-i", videoPath,
    "-vf", `fps=1/${intervalSec},scale=${width}:-2`,
    "-q:v", "4",
    path.join(framesDir, "f%04d.jpg"),
  ]);

  const files = (await readdir(framesDir)).filter((f) => /\.jpg$/i.test(f)).sort();
  const frames = files.map((f, i) => ({ t: +(i * intervalSec).toFixed(2), file: path.join(framesDir, f) }));

  // Audio: 16 kHz mono WAV (what whisper.cpp wants). Absent/silent tracks fail gracefully.
  const audioPath = path.join(workDir, "audio.wav");
  let hasAudio = true;
  try {
    await run(bin, ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", audioPath]);
  } catch {
    hasAudio = false;
  }

  let durationSec = 0;
  try {
    durationSec = Math.round(durationFromMp4Buffer(readFileSync(videoPath)) * 10) / 10;
  } catch {
    /* non-mp4 or no mvhd; leave 0 */
  }

  return { frames, audioPath: hasAudio ? audioPath : null, durationSec };
}
