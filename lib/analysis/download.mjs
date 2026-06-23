// Fetch a reel video to a local file. Direct CDN mp4s (Graph API media_url) are
// streamed with fetch; Instagram *page* URLs are downloaded with yt-dlp.
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const PY = process.env.PYTHON_BIN || "python";

export function isInstagramUrl(u) {
  return /instagram\.com\/(reel|reels|p|tv)\//i.test(u);
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

/** Download a reel: yt-dlp for instagram page URLs, plain fetch for direct mp4s. */
export async function downloadReel(url, dest) {
  if (!isInstagramUrl(url)) return fetchToFile(url, dest);
  await runPy(["-m", "yt_dlp", "--no-warnings", "-f", "mp4/best", "-o", dest, url]);
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
