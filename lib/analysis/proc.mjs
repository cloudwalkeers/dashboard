// Small process helpers shared by the analysis pipeline.
import { spawn } from "node:child_process";

let _ffmpeg;

/** Resolve an ffmpeg binary: $FFMPEG_BIN → the ffmpeg-static npm package → "ffmpeg" on PATH. */
export async function ffmpegPath() {
  if (_ffmpeg) return _ffmpeg;
  if (process.env.FFMPEG_BIN) return (_ffmpeg = process.env.FFMPEG_BIN);
  try {
    const m = await import("ffmpeg-static");
    _ffmpeg = m.default || "ffmpeg";
  } catch {
    _ffmpeg = "ffmpeg"; // fall back to PATH
  }
  return _ffmpeg;
}

/** Run a binary, resolving with stderr text on exit 0, rejecting with a trimmed error otherwise. */
export function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => reject(new Error(`${bin} failed to start: ${e.message}`)));
    p.on("close", (c) =>
      c === 0 ? resolve(err) : reject(new Error(`${bin} exited ${c}: ${err.slice(-600)}`))
    );
  });
}
