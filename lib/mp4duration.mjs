// Pure-Node MP4/MOV duration probe — no ffmpeg required.
//
// Instagram's Graph API does not expose a reel's duration, but for media you
// own it returns `media_url`, a CDN link to the actual .mp4. We download it
// (reels are small) and read the duration straight out of the file's `mvhd`
// atom:  duration / timescale  =  seconds.

const MAX_BYTES = 80 * 1024 * 1024; // safety cap; reels are far smaller

/** Download a video URL and return its duration in seconds. */
export async function probeDurationFromUrl(url, { signal } = {}) {
  const res = await fetch(url, { signal, redirect: "follow" });
  if (!res.ok) throw new Error("media_url fetch failed: HTTP " + res.status);
  if (!res.body) throw new Error("media_url returned no body");

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    total += value.length;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch {}
      break;
    }
  }
  const secs = durationFromMp4Buffer(Buffer.concat(chunks, total));
  if (!(secs > 0)) throw new Error("could not locate mvhd duration in MP4");
  return secs;
}

/** Parse an in-memory MP4 buffer and return duration in seconds (0 if absent). */
export function durationFromMp4Buffer(buf) {
  const moov = findBox(buf, 0, buf.length, "moov");
  if (!moov) return 0;
  const mvhd = findBox(buf, moov.start, moov.end, "mvhd");
  if (!mvhd) return 0;

  const p = mvhd.start; // first payload byte = version
  const version = buf[p];
  if (version === 1) {
    // version(1) flags(3) creation(8) modification(8) timescale(4) duration(8)
    const timescale = buf.readUInt32BE(p + 1 + 3 + 16);
    const duration = Number(buf.readBigUInt64BE(p + 1 + 3 + 16 + 4));
    return timescale ? duration / timescale : 0;
  }
  // version(1) flags(3) creation(4) modification(4) timescale(4) duration(4)
  const timescale = buf.readUInt32BE(p + 1 + 3 + 8);
  const duration = buf.readUInt32BE(p + 1 + 3 + 8 + 4);
  return timescale ? duration / timescale : 0;
}

// Scan sibling boxes within [from, to) for `type`; return the payload span
// (start = first byte after the box header).
function findBox(buf, from, to, type) {
  let off = from;
  while (off + 8 <= to) {
    let size = buf.readUInt32BE(off);
    const boxType = buf.toString("latin1", off + 4, off + 8);
    let header = 8;
    if (size === 1) {
      if (off + 16 > to) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) {
      size = to - off; // box extends to end of its container
    }
    if (size < header) break;
    if (boxType === type) return { start: off + header, end: Math.min(off + size, to) };
    off += size;
  }
  return null;
}
