#!/usr/bin/env node
// Backfill every reel on the connected account into Supabase via the Graph API.
// Owned reels expose a direct media_url, so no scraping is needed. Reels already
// stored in Supabase are skipped (no OpenAI re-spend) unless --force.
//   npm run backfill [--days 21] [--interval 2] [--max 100] [--force]
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isConfigured as graphConfigured, fetchProfile, fetchAllMedia } from "../lib/graph.mjs";
import { analyzeReel } from "../lib/analysis/analyze.mjs";
import { isConfigured as supaConfigured } from "../lib/store/supabase.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(__dirname, "..", ".env"));

const args = process.argv.slice(2);
const opts = { intervalSec: 2, force: false, days: 0, max: Number(process.env.MAX_REELS || 100) };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--force") opts.force = true;
  else if (a === "--days") opts.days = Number(args[++i]) || 0;
  else if (a === "--interval") opts.intervalSec = Number(args[++i]) || 2;
  else if (a === "--max") opts.max = Number(args[++i]) || 100;
}

if (!graphConfigured()) {
  console.error("\n  Backfill needs the Instagram Graph API configured. Add to .env:");
  console.error("    IG_USER_ID=<your Instagram business/creator account id (a long number)>");
  console.error("    IG_ACCESS_TOKEN=<long-lived token with instagram_basic, instagram_manage_insights,");
  console.error("                     pages_show_list, pages_read_engagement>");
  console.error("  Then: npm run backfill\n");
  process.exit(1);
}
if (!supaConfigured()) console.warn("  (heads-up) SUPABASE_* not set — results won't be stored.\n");

const profile = await fetchProfile();
const account = profile.username || "";
console.log(`\n  Backfilling reels for @${account || "(unknown account)"}…`);

const media = await fetchAllMedia({ max: opts.max });
let reels = media.filter((m) => m.media_product_type === "REELS" || m.media_type === "VIDEO");
if (opts.days > 0) {
  const cut = Date.now() - opts.days * 86400000;
  reels = reels.filter((m) => Date.parse(m.timestamp) >= cut);
}
console.log(`  ${reels.length} reel(s) to consider${opts.days ? ` (last ${opts.days} days)` : ""}.\n`);

let extracted = 0, cached = 0, skipped = 0, failed = 0, cost = 0;
for (const m of reels) {
  const mm = m.permalink && m.permalink.match(/\/(reel|reels|p|tv)\/([^/?#]+)/);
  const shortcode = (mm && mm[2]) || m.id;
  if (!m.media_url) {
    console.log(`  - ${shortcode}: no media_url (can't download), skipped`);
    skipped++;
    continue;
  }
  try {
    const { result, cached: wasCached } = await analyzeReel({
      video: m.media_url,
      id: shortcode,
      account,
      publishedAt: m.timestamp,
      permalink: m.permalink,
      metrics: { cap: m.caption || "" },
      intervalSec: opts.intervalSec,
      force: opts.force,
      onStep: () => {},
    });
    if (wasCached) {
      console.log(`  • ${shortcode}: already in Supabase, skipped`);
      cached++;
    } else {
      const c = result.meta?.costUsd || 0;
      cost += c;
      extracted++;
      console.log(`  ✓ ${shortcode}: ${result.frames.length} frames · ${result.transcript.segments.length} segs · $${c.toFixed(3)}`);
    }
  } catch (e) {
    failed++;
    console.log(`  ✗ ${shortcode}: ${e && e.message ? e.message : e}`);
  }
}

console.log(`\n  Done — extracted ${extracted}, cached ${cached}, skipped ${skipped}, failed ${failed}. est $${cost.toFixed(2)}\n`);

function loadEnv(f) {
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]] == null || process.env[m[1]] === "") process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
