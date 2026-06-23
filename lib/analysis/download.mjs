// Fetch a reel video to a local file. Direct CDN mp4s (Graph API media_url) are
// streamed with fetch; Instagram *page* URLs are downloaded with yt-dlp.
import { createWriteStream, statSync, openSync, readSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ffmpegPath } from "./proc.mjs";

const PY = process.env.PYTHON_BIN || "python";

export function isInstagramUrl(u) {
  // Matches both instagram.com/reel/<code> and instagram.com/<account>/reel/<code>.
  return /instagram\.com\/(?:[^/?#]+\/)?(reel|reels|p|tv)\//i.test(u);
}

/** Pull account handle + shortcode out of an instagram.com/<acct>/reel/<code>/ URL. */
export function parseReelUrl(u) {
  const m = String(u).match(/instagram\.com\/(?:([^/?#]+)\/)?(?:reel|reels|p|tv)\/([^/?#]+)/i);
  if (!m) return { account: null, shortcode: null };
  const seg = m[1];
  const account = seg && !/^(reel|reels|p|tv)$/i.test(seg) ? seg : null;
  return { account, shortcode: m[2] };
}

export async function fetchToFile(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error("download failed: HTTP " + res.status);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/** Download a reel: yt-dlp for instagram page URLs, plain fetch for direct mp4s.
 *  Forces a valid mp4 (remux via ffmpeg-static) and validates the result, so a
 *  truncated/HTML download fails loudly instead of corrupting the pipeline. */
export async function downloadReel(url, dest) {
  if (!isInstagramUrl(url)) return fetchToFile(url, dest);
  // Newer reels are DASH-only (separate video+audio, no progressive mp4), so
  // prefer bestvideo+bestaudio and let ffmpeg merge. "best" alone can match a
  // broken placeholder format that returns HTML. NOTE: --ffmpeg-location wants
  // the DIRECTORY (passing the binary path stops yt-dlp from merging → HTML).
  // Forward slashes: node's Windows spawn mangles a backslash path here, so
  // yt-dlp can't find ffmpeg → can't merge → falls back to a broken HTML format.
  const ffDir = path.dirname(await ffmpegPath()).replace(/\\/g, "/");
  await runPy([
    "-m", "yt_dlp", "--no-warnings", "--retries", "5",
    "--force-overwrites", "--no-part", // always re-fetch; never reuse a stale/partial file
    "--ffmpeg-location", ffDir,
    "-f", "bv*+ba/b",
    "--merge-output-format", "mp4",
    "-o", dest, url,
  ]);
  // Validate: a real mp4 has an "ftyp" box at the start; reject HTML pages etc.
  let size = 0, head = "";
  try { size = statSync(dest).size; } catch {}
  try {
    const fd = openSync(dest, "r");
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, 4096, 0);
    closeSync(fd);
    head = buf.subarray(0, n).toString("latin1");
  } catch {}
  if (size < 10000 || !head.slice(0, 64).includes("ftyp")) {
    const html = /<!doctype|<html/i.test(head);
    throw new Error("download produced an invalid video" + (html ? " (got an HTML page — the reel may be private/age-gated or need login)" : " — the reel may only have streaming formats") + ".");
  }
}

/** Light metadata (account, publish date, caption) via yt-dlp, no download. */
export async function reelMeta(url) {
  try {
    const out = await runPyCapture([
      "-m", "yt_dlp", "--no-warnings", "--skip-download",
      "--print", "%(channel)s|%(upload_date)s|%(title)s", url,
    ]);
    const [acc, date, ...title] = out.trim().split("|");
    return {
      account: acc || null,
      publishedAt: /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : null,
      caption: title.join("|") || "",
    };
  } catch {
    return {};
  }
}

function runPy(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => reject(new Error("yt-dlp failed to start: " + e.message + " (is Python + yt-dlp installed?)")));
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error("yt-dlp exited " + c + ": " + err.slice(-300)))));
  });
}

function runPyCapture(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error("yt-dlp exited " + c))));
  });
}
