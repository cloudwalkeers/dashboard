#!/usr/bin/env node
// PoC runner for the per-reel analysis pipeline.
//   npm run analyze -- <video.mp4 | https-url> [--id NAME] [--metrics reel.json] [--interval 2] [--dry-run]
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyzeReel } from "../lib/analysis/analyze.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(__dirname, "..", ".env"));

const args = process.argv.slice(2);
const opts = { dryRun: false, intervalSec: 2 };
let video = null;
let metricsPath = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--dry-run") opts.dryRun = true;
  else if (a === "--reuse") opts.reuse = true;
  else if (a === "--force") opts.force = true;
  else if (a === "--id") opts.id = args[++i];
  else if (a === "--interval") opts.intervalSec = Number(args[++i]) || 2;
  else if (a === "--metrics") metricsPath = args[++i];
  else if (!a.startsWith("--")) video = a;
}

if (!video) {
  console.error("Usage: npm run analyze -- <video.mp4 | https-url> [--id NAME] [--metrics reel.json] [--interval 2] [--dry-run] [--reuse]");
  process.exit(1);
}

let metrics = {};
let retention = [];
if (metricsPath && existsSync(metricsPath)) {
  metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
  retention = metrics.retention || metrics.ret || [];
}

console.log(`\n  Analyzing ${video}${opts.dryRun ? "  (dry-run — no API/whisper calls)" : ""}`);
const t0 = Date.now();
try {
  const { result, jsonPath } = await analyzeReel({
    video,
    metrics,
    retention,
    ...opts,
    onStep: (s) => process.stdout.write(`  · ${s}…\n`),
  });
  console.log(`\n  ✓ ${result.frames.length} frames · transcript: ${result.transcript.source} (${result.transcript.segments.length} segs) · ${result.video.durationSec}s`);
  console.log(`  ✓ wrote ${path.relative(process.cwd(), jsonPath)}  (${((Date.now() - t0) / 1000).toFixed(1)}s, est $${result.meta.costUsd})`);
  if (!opts.dryRun) console.log(`\n  Summary: ${result.analysis.summary}`);
} catch (e) {
  console.error("\n  ✗ " + (e && e.message ? e.message : e));
  process.exit(1);
}

function loadEnv(f) {
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]] == null || process.env[m[1]] === "")
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
