// Tiny zero-dependency local server.
//   GET /            -> the dashboard
//   GET /support.js  -> the dc-runtime
//   GET /api/data    -> live Instagram payload (or demo when no creds / on error)
//                       ?demo=1 forces demo, ?refresh=1 bypasses the cache
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { isConfigured, collectReels } from "./lib/graph.mjs";
import { toPayload } from "./lib/transform.mjs";
import { demoPayload } from "./lib/demo.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const ANALYSIS = path.join(__dirname, "analysis");

loadEnv();

const PORT = Number(process.env.PORT || 5173);
const CACHE_MS = 5 * 60 * 1000;
let cache = null; // { t, payload }

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");

    if (u.pathname === "/api/data") {
      const payload = await getData(
        u.searchParams.get("refresh") === "1",
        u.searchParams.get("demo") === "1"
      );
      return send(res, 200, ".json", JSON.stringify(payload));
    }

    // Content Creation: extract a reel from a pasted URL (download → pipeline → store).
    // Returns the stored row instantly if it's already been extracted.
    if (u.pathname === "/api/extract" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.url) return send(res, 400, ".json", JSON.stringify({ error: "missing url" }));
      // Stream progress as newline-delimited JSON: {step} … then {done,result} or {error}.
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" });
      const write = (o) => res.write(JSON.stringify(o) + "\n");
      try {
        const { analyzeFromUrl } = await import("./lib/analysis/web.mjs");
        const result = await analyzeFromUrl(body.url, {
          intervalSec: Number(body.interval) || 2,
          force: !!body.force,
          onStep: (s) => write({ step: s }),
        });
        write({ done: true, result });
      } catch (e) {
        write({ error: e && e.message ? e.message : String(e) });
      }
      return res.end();
    }

    // Generate a new script from a reference reel (id) or a supplied transcript.
    if (u.pathname === "/api/generate-script" && req.method === "POST") {
      const body = await readJson(req);
      try {
        const { generateScript } = await import("./lib/analysis/script.mjs");
        const out = await generateScript(body);
        return send(res, 200, ".json", JSON.stringify(out));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Reels Pipeline: saved scripts + visual prompts (list / save / edit / delete).
    if (u.pathname === "/api/scripts") {
      const mod = await import("./lib/store/scripts.mjs");
      if (!mod.isConfigured())
        return send(res, 200, ".json", JSON.stringify({ items: [], configured: false }));
      try {
        if (req.method === "GET")
          return send(res, 200, ".json", JSON.stringify({ items: await mod.listScripts(), configured: true }));
        if (req.method === "POST") {
          const body = await readJson(req);
          return send(res, 200, ".json", JSON.stringify({ item: await mod.saveScript(body) }));
        }
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }
    const sm = u.pathname.match(/^\/api\/scripts\/([^/]+)$/);
    if (sm) {
      const mod = await import("./lib/store/scripts.mjs");
      const id = decodeURIComponent(sm[1]);
      try {
        if (req.method === "PUT") {
          const body = await readJson(req);
          return send(res, 200, ".json", JSON.stringify({ item: await mod.saveScript({ ...body, id }) }));
        }
        if (req.method === "DELETE")
          return send(res, 200, ".json", JSON.stringify(await mod.deleteScript(id)));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Reels discovery: library (list/edit/delete) + live discover (hashtag / links).
    if (u.pathname === "/api/discovery") {
      const store = await import("./lib/store/discovery.mjs");
      if (!store.isConfigured())
        return send(res, 200, ".json", JSON.stringify({ items: [], categories: [], configured: false }));
      try {
        if (req.method === "GET") {
          const category = u.searchParams.get("category") || null;
          const tag = u.searchParams.get("tag") || null;
          const [items, cats] = await Promise.all([store.listDiscovery({ category, tag }), store.categories()]);
          return send(res, 200, ".json", JSON.stringify({ items, categories: cats, configured: true }));
        }
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }
    const dm = u.pathname.match(/^\/api\/discovery\/([^/]+)$/);
    if (dm) {
      const store = await import("./lib/store/discovery.mjs");
      const id = decodeURIComponent(dm[1]);
      try {
        if (req.method === "PUT") {
          const body = await readJson(req);
          return send(res, 200, ".json", JSON.stringify({ item: await store.updateDiscovery(id, body) }));
        }
        if (req.method === "DELETE")
          return send(res, 200, ".json", JSON.stringify(await store.deleteDiscovery(id)));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }
    if (u.pathname === "/api/discover" && req.method === "POST") {
      const body = await readJson(req);
      try {
        const { discoverByHashtag, discoverByLinks } = await import("./lib/discover.mjs");
        let items;
        if (body.urls || body.links) items = await discoverByLinks(body.urls || body.links, { category: body.category });
        else if (body.hashtag) items = await discoverByHashtag(body.hashtag, { type: body.type || "top", category: body.category });
        else return send(res, 400, ".json", JSON.stringify({ error: "provide a hashtag or urls" }));
        return send(res, 200, ".json", JSON.stringify({ items }));
      } catch (e) {
        return send(res, e && e.code === "NO_CREDS" ? 200 : 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e), code: e && e.code }));
      }
    }

    // Lab: causal ledger (de-confounded hypotheses) + the next experiment.
    if (u.pathname === "/api/causal" && req.method === "GET") {
      const causal = await import("./lib/causal.mjs");
      if (!causal.isConfigured()) return send(res, 200, ".json", JSON.stringify({ configured: false, hypotheses: [], n: 0 }));
      try {
        return send(res, 200, ".json", JSON.stringify(await causal.insights({ outcome: u.searchParams.get("outcome") || "rate" })));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }
    if (u.pathname === "/api/causal/rebuild" && req.method === "POST") {
      const body = await readJson(req);
      const causal = await import("./lib/causal.mjs");
      if (!causal.isConfigured()) return send(res, 200, ".json", JSON.stringify({ configured: false }));
      try {
        const features = await causal.buildFeatures({ force: !!body.force });
        const out = await causal.insights({ outcome: body.outcome || "rate" });
        return send(res, 200, ".json", JSON.stringify({ ...out, features }));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Studio: RAG "what works" advisor (generate / refine, grounded in the reels).
    if (u.pathname === "/api/studio" && req.method === "POST") {
      const body = await readJson(req);
      try {
        const studio = await import("./lib/studio.mjs");
        if (!studio.isConfigured())
          return send(res, 200, ".json", JSON.stringify({ error: "Supabase not configured", configured: false }));
        const out = await studio.studioGenerate({ brief: body.brief || "", goal: body.goal || "likes", history: body.history || [] });
        return send(res, 200, ".json", JSON.stringify(out));
      } catch (e) {
        return send(res, e && e.code === "NO_DATA" ? 200 : 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e), code: e && e.code }));
      }
    }

    // Clippers: command center (roster + per-platform reel assignments + perf).
    if (u.pathname === "/api/clippers") {
      const mod = await import("./lib/store/clippers.mjs");
      if (!mod.isConfigured())
        return send(res, 200, ".json", JSON.stringify({ clippers: [], configured: false }));
      try {
        if (req.method === "GET")
          return send(res, 200, ".json", JSON.stringify({ clippers: await mod.listClippers(), configured: true }));
        if (req.method === "POST") {
          const body = await readJson(req);
          return send(res, 200, ".json", JSON.stringify({ item: await mod.createClipper(body) }));
        }
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }
    const cm = u.pathname.match(/^\/api\/clippers\/([^/]+)$/);
    if (cm) {
      const mod = await import("./lib/store/clippers.mjs");
      const id = decodeURIComponent(cm[1]);
      try {
        if (req.method === "PUT") {
          const body = await readJson(req);
          return send(res, 200, ".json", JSON.stringify({ item: await mod.updateClipper(id, body) }));
        }
        if (req.method === "DELETE")
          return send(res, 200, ".json", JSON.stringify(await mod.deleteClipper(id)));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }
    // Clip assignments: create (reel × platforms) / update perf / delete.
    if (u.pathname === "/api/assignments" && req.method === "POST") {
      const mod = await import("./lib/store/clippers.mjs");
      try {
        const body = await readJson(req);
        return send(res, 200, ".json", JSON.stringify({ items: await mod.createAssignments(body) }));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }
    const am = u.pathname.match(/^\/api\/assignments\/([^/]+)$/);
    if (am) {
      const mod = await import("./lib/store/clippers.mjs");
      const id = decodeURIComponent(am[1]);
      try {
        if (req.method === "PUT") {
          const body = await readJson(req);
          return send(res, 200, ".json", JSON.stringify({ item: await mod.updateAssignment(id, body) }));
        }
        if (req.method === "DELETE")
          return send(res, 200, ".json", JSON.stringify(await mod.deleteAssignment(id)));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Per-reel AI breakdown (precomputed by `npm run analyze`).
    const ar = u.pathname.match(/^\/api\/reel\/([^/]+)\/analyze$/);
    if (ar) {
      const f = path.join(ANALYSIS, decodeURIComponent(ar[1]) + ".json");
      if (!f.startsWith(ANALYSIS) || !existsSync(f))
        return send(res, 404, ".json",
          JSON.stringify({ error: "not analyzed", hint: "Run: npm run analyze -- <video> --id " + ar[1] }));
      return send(res, 200, ".json", await readFile(f));
    }

    // Extracted frame images referenced by the analysis JSON.
    if (u.pathname.startsWith("/analysis/")) {
      const file = path.join(ANALYSIS, decodeURIComponent(u.pathname.replace(/^\/analysis\//, "")));
      if (!file.startsWith(ANALYSIS) || !/\.(jpg|jpeg|png|json)$/i.test(file) || !existsSync(file))
        return send(res, 404, ".html", "Not found");
      return send(res, 200, path.extname(file), await readFile(file));
    }

    if (u.pathname === "/favicon.ico") return send(res, 204, ".ico", "");

    const rel = u.pathname === "/" ? "index.html" : u.pathname.replace(/^\/+/, "");
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return send(res, 403, ".html", "Forbidden");
    if (!existsSync(file)) return send(res, 404, ".html", "Not found");

    const body = await readFile(file);
    return send(res, 200, path.extname(file), body);
  } catch (e) {
    return send(res, 500, ".html", "Server error: " + (e && e.message));
  }
});

server.listen(PORT, () => {
  const mode = isConfigured() ? "LIVE Instagram data" : "DEMO data (no .env credentials found)";
  console.log("");
  console.log("  Reels dashboard running");
  console.log("  → http://localhost:" + PORT);
  console.log("  Mode: " + mode);
  if (!isConfigured()) {
    console.log("  Add IG_USER_ID + IG_ACCESS_TOKEN to .env for live data (see README.md).");
  }
  console.log("");
});

async function getData(force, demo) {
  // 1) Live Graph API when credentials are configured.
  if (!demo && isConfigured()) {
    if (cache && !force && Date.now() - cache.t < CACHE_MS) return cache.payload;
    try {
      const raw = await collectReels({ max: Number(process.env.MAX_REELS || 40) });
      const payload = toPayload(raw, { source: "live" });
      cache = { t: Date.now(), payload };
      // Persist the live metrics (one snapshot/reel/day) — best-effort, non-blocking.
      import("./lib/store/metrics.mjs")
        .then((m) => (m.isConfigured() ? m.storeMetrics(payload) : null))
        .then((r) => r && r.stored && console.log("  metrics → supabase:", r.stored, "reel(s),", r.failed, "failed"))
        .catch((e) => console.log("  metrics store skipped:", e && e.message ? e.message : e));
      return payload;
    } catch (e) {
      return { defs: [], trend: { reachS: [], playsS: [] }, meta: { source: "live", error: e && e.message ? e.message : String(e) } };
    }
  }
  if (demo) return demoPayload();
  // 2) No live creds → show the REAL reels stored in Supabase (not demo).
  try {
    const stored = await import("./lib/store/stored.mjs");
    if (stored.isConfigured()) {
      const payload = await stored.storedPayload();
      if (payload && payload.defs && payload.defs.length) return payload;
    }
  } catch (e) {
    console.log("  stored payload skipped:", e && e.message ? e.message : e);
  }
  // 3) Nothing stored → demo so the dashboard still works out of the box.
  return demoPayload();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => {
      d += c;
      if (d.length > 5e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res, code, ext, body) {
  res.writeHead(code, { "content-type": TYPES[ext] || "application/octet-stream" });
  res.end(body);
}

// Dead-simple .env loader (avoids a dependency). Does not override real env vars.
function loadEnv() {
  const f = path.join(__dirname, ".env");
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const val = m[2].replace(/^["']|["']$/g, "");
    if (process.env[key] == null || process.env[key] === "") process.env[key] = val;
  }
}
