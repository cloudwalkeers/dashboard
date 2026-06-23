#!/usr/bin/env node
// Backfill reels from a LIST OF LINKS — no Graph API needed (yt-dlp downloads
// each public reel). Each reel runs the full pipeline and is stored in Supabase;
// reels already stored are skipped (no OpenAI re-spend) unless --force.
//   npm run backfill:links -- links.txt
//   npm run backfill:links -- https://instagram.com/reel/AAA/ https://instagram.com/reel/BBB/
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyzeFromUrl } from "../lib/analysis/web.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(__dirname, "..", ".env"));

const args = process.argv.slice(2);
const opts = { force: false, intervalSec: 2 };
const inputs = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--force") opts.force = true;
  else if (a === "--interval") opts.intervalSec = Number(args[++i]) || 2;
  else inputs.push(a);
}

// Each input is a URL, or a text file with one URL per line (# comments allowed).
const urls = [];
for (const inp of inputs) {
  if (/^https?:/i.test(inp)) urls.push(inp);
  else if (existsSync(inp)) {
    for (const line of readFileSync(inp, "utf8").split(/\r?\n/)) {
      const u = line.trim();
      if (u && !u.startsWith("#")) urls.push(u);
    }
  } else console.error("  (skipping unknown input: " + inp + ")");
}

if (!urls.length) {
  console.error("Usage: npm run backfill:links -- <links.txt | url1 url2 …> [--interval 2] [--force]");
  process.exit(1);
}

console.log(`\n  Backfilling ${urls.length} reel link(s)…\n`);
let extracted = 0, cached = 0, failed = 0, cost = 0;
for (const url of urls) {
  console.log("  " + url);
  try {
    const result = await analyzeFromUrl(url, {
      intervalSec: opts.intervalSec,
      force: opts.force,
      onStep: (s) => process.stdout.write(`    · ${s}\n`),
    });
    if (result.cached) {
      cached++;
      console.log("    • already in Supabase, skipped");
    } else {
      const c = result.meta?.costUsd || 0;
      cost += c;
      extracted++;
      console.log(`    ✓ ${result.frames.length} frames · ${result.transcript.segments.length} segs · $${c.toFixed(3)}`);
    }
  } catch (e) {
    failed++;
    console.log("    ✗ " + (e && e.message ? e.message : e));
  }
}
console.log(`\n  Done — extracted ${extracted}, cached ${cached}, failed ${failed}. est $${cost.toFixed(2)}\n`);

function loadEnv(f) {
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]] == null || process.env[m[1]] === "") process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
