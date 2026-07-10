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
import { loadToken, refreshIfNeeded } from "./lib/ig-token.mjs";

// cloudwalkeers multi-tenant layer: creator auth + per-creator platform connections
import { requireCreator } from "./lib/auth.mjs";
import * as igOAuth from "./lib/oauth/instagram.mjs";
import { saveConnection, listConnections, deleteConnection, igAuthForCreator, saveFollowers } from "./lib/oauth/connections.mjs";
import { signState, verifyState } from "./lib/oauth/state.mjs";
import { getDb } from "./lib/store/supabase.mjs";
import { enterScope, runInScope, isScoped, currentScope, currentIgAccount, currentCreatorId, currentIgToken } from "./lib/scope.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const ANALYSIS = path.join(__dirname, "analysis");

loadEnv();
loadToken(); // adopt the persisted/refreshed IG token so it survives past its 60-day expiry

const PORT = Number(process.env.PORT || 5173);
const CACHE_MS = 5 * 60 * 1000;
// Caches are keyed per creator (multi-tenant) — 'global' covers the CLI/env path.
const liveCache = new Map();  // key -> { t, payload }
const trendCaches = new Map(); // key -> { t, trend } — real daily reach, cached ~30 min
const cacheKey = () => currentCreatorId() || "global";

// Real daily account trend (reach is exposed per-day; daily plays is not, so we
// derive it from real reach × the catalogue's plays/reach ratio). Cached so the
// fast stored view isn't slowed by an Instagram round-trip on every load.
async function realTrend(defs) {
  if (!isConfigured()) return null;
  const key = cacheKey();
  const hit = trendCaches.get(key);
  if (hit && Date.now() - hit.t < 30 * 60 * 1000) return hit.trend;
  try {
    const { fetchAccountTrend } = await import("./lib/graph.mjs");
    const t = await fetchAccountTrend(90);
    if (!t.reachS || !t.reachS.some((v) => v > 0)) return null;
    let reachS = t.reachS;
    const firstNz = reachS.findIndex((v) => v > 0);            // drop the empty pre-history
    if (firstNz > 0) reachS = reachS.slice(firstNz);
    let playsS = (t.playsS && t.playsS.length) ? t.playsS.slice(-reachS.length) : null;
    if (!playsS) {
      const tp = defs.reduce((s, d) => s + (d.plays || 0), 0), tr = defs.reduce((s, d) => s + (d.reach || 0), 0);
      const ratio = tr ? tp / tr : 1.15;
      playsS = reachS.map((v) => Math.round(v * ratio));
    }
    const trend = { reachS, playsS, reachModeled: false, playsModeled: !(t.playsS && t.playsS.length) };
    trendCaches.set(key, { t: Date.now(), trend });
    return trend;
  } catch { return null; }
}

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

    // Image proxy: Instagram/fbcdn profile pics + reel thumbnails block hotlinking
    // from the browser, so fetch them server-side (host-allowlisted against SSRF) and
    // stream them back. Public images — kept OUT of the creator auth gate so <img> tags
    // (which can't send a JSON 401) always resolve.
    if (u.pathname === "/api/img") {
      const raw = u.searchParams.get("u") || "";
      let target; try { target = new URL(raw); } catch { return send(res, 400, ".json", JSON.stringify({ error: "bad url" })); }
      const okHost = /(^|\.)(cdninstagram\.com|fbcdn\.net|instagram\.com)$/i.test(target.hostname);
      if (target.protocol !== "https:" || !okHost) return send(res, 403, ".json", JSON.stringify({ error: "host not allowed" }));
      try {
        const r = await fetch(target.href, { headers: { "user-agent": "Mozilla/5.0", accept: "image/*,*/*" } });
        if (!r.ok) { res.writeHead(r.status); return res.end(); }
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, { "content-type": r.headers.get("content-type") || "image/jpeg", "cache-control": "public, max-age=86400" });
        return res.end(buf);
      } catch { res.writeHead(502); return res.end(); }
    }

    // Multi-tenant gate: every creator-data endpoint requires login and runs scoped
    // to the logged-in creator — their reels, their scripts, their clippers, and
    // live Instagram calls made with THEIR connected token (never the shared one).
    if (/^\/api\/(data|causal|predict|drops|attention|audit|hooks|extract|generate-script|scripts|skills|guides|pipeline-videos|discovery|discover|watchlist|watch|clippers|assignments|studio|animate|youtube|reel)(\/|$)/.test(u.pathname)) {
      const creator = await requireCreator(req);
      if (!creator) return send(res, 401, ".json", JSON.stringify({ error: "unauthenticated", code: "AUTH" }));
      let igAuth = null;
      try { igAuth = await igAuthForCreator(creator.id); } catch { /* treated as not connected */ }
      enterScope({ creator, igAccount: igAuth && igAuth.username, igToken: igAuth && igAuth.token, igFollowers: igAuth && igAuth.followers });
    }

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

    // Guides: generate a written guide from a reel (streaming), then list/edit/delete.
    if (u.pathname === "/api/guides") {
      const store = await import("./lib/store/guides.mjs");
      if (!store.isConfigured())
        return send(res, 200, ".json", JSON.stringify({ items: [], configured: false }));
      if (req.method === "GET") {
        try { return send(res, 200, ".json", JSON.stringify({ items: await store.listGuides(), configured: true })); }
        catch (e) { return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) })); }
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        if (!body.url && !body.brief && !body.sourceId) return send(res, 400, ".json", JSON.stringify({ error: "provide a reel URL, or a prompt / source guide" }));
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" });
        const write = (o) => res.write(JSON.stringify(o) + "\n");
        try {
          const guides = await import("./lib/guides.mjs");
          let guide;
          if (body.url) {
            guide = await guides.generateGuide(body.url, { onStep: (s) => write({ step: s }) });
          } else {
            write({ step: "writing guide" });
            guide = await guides.generateGuideFromPrompt({ brief: body.brief || "", sourceId: body.sourceId || null });
          }
          const saved = await store.createGuide(guide);
          write({ done: true, guide: saved });
        } catch (e) { write({ error: e && e.message ? e.message : String(e) }); }
        return res.end();
      }
    }
    const grm = u.pathname.match(/^\/api\/guides\/([^/]+)\/refine$/);
    if (grm && req.method === "POST") {
      const store = await import("./lib/store/guides.mjs");
      const id = decodeURIComponent(grm[1]);
      try {
        const body = await readJson(req);
        const g = await store.getGuide(id);
        if (!g) return send(res, 404, ".json", JSON.stringify({ error: "guide not found" }));
        const { refineGuide } = await import("./lib/guides.mjs");
        const refined = await refineGuide({ title: g.title, body_md: g.body_md, instruction: body.instruction || "" });
        const saved = await store.updateGuide(id, { title: refined.title, body_md: refined.body_md });
        return send(res, 200, ".json", JSON.stringify({ item: saved }));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }
    const gdm = u.pathname.match(/^\/api\/guides\/([^/]+)$/);
    if (gdm) {
      const store = await import("./lib/store/guides.mjs");
      const id = decodeURIComponent(gdm[1]);
      try {
        if (req.method === "GET") return send(res, 200, ".json", JSON.stringify({ item: await store.getGuide(id) }));
        if (req.method === "PUT") { const body = await readJson(req); return send(res, 200, ".json", JSON.stringify({ item: await store.updateGuide(id, body) })); }
        if (req.method === "DELETE") return send(res, 200, ".json", JSON.stringify(await store.deleteGuide(id)));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Creator skills: per-tenant reusable instructions injected into script generation.
    if (u.pathname === "/api/skills") {
      const store = await import("./lib/store/skills.mjs");
      if (!store.isConfigured())
        return send(res, 200, ".json", JSON.stringify({ items: [], configured: false }));
      try {
        if (req.method === "GET")
          return send(res, 200, ".json", JSON.stringify({ items: await store.listSkills(), configured: true }));
        if (req.method === "POST") {
          const body = await readJson(req);
          return send(res, 200, ".json", JSON.stringify({ item: await store.saveSkill(body) }));
        }
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }
    const skm = u.pathname.match(/^\/api\/skills\/([^/]+)$/);
    if (skm) {
      const store = await import("./lib/store/skills.mjs");
      const id = decodeURIComponent(skm[1]);
      try {
        if (req.method === "PUT") {
          const body = await readJson(req);
          return send(res, 200, ".json", JSON.stringify({ item: await store.saveSkill({ ...body, id }) }));
        }
        if (req.method === "DELETE")
          return send(res, 200, ".json", JSON.stringify(await store.deleteSkill(id)));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Pipeline "Videos": reels saved from Discovery for later extraction.
    if (u.pathname === "/api/pipeline-videos") {
      const store = await import("./lib/store/pipelineVideos.mjs");
      if (!store.isConfigured())
        return send(res, 200, ".json", JSON.stringify({ items: [], configured: false }));
      try {
        if (req.method === "GET")
          return send(res, 200, ".json", JSON.stringify({ items: await store.listVideos(), configured: true }));
        if (req.method === "POST") {
          const body = await readJson(req);
          return send(res, 200, ".json", JSON.stringify({ item: await store.saveVideo(body) }));
        }
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }
    const pvm = u.pathname.match(/^\/api\/pipeline-videos\/([^/]+)$/);
    if (pvm) {
      const store = await import("./lib/store/pipelineVideos.mjs");
      const id = decodeURIComponent(pvm[1]);
      try {
        if (req.method === "PUT") {
          const body = await readJson(req);
          return send(res, 200, ".json", JSON.stringify({ item: await store.updateVideo(id, body) }));
        }
        if (req.method === "DELETE")
          return send(res, 200, ".json", JSON.stringify(await store.deleteVideo(id)));
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

    // Trending lane: shared creator watchlist → filterable content recommendations.
    // GET  /api/watchlist            → watched creators
    // POST /api/watchlist            → { username, region } add + immediate sweep
    // DEL  /api/watchlist/:username  → remove
    if (u.pathname === "/api/watchlist") {
      const wl = await import("./lib/watchlist.mjs");
      if (!wl.isConfigured())
        return send(res, 200, ".json", JSON.stringify({ creators: [], configured: false }));
      const wstore = await import("./lib/store/watchlist.mjs");
      try {
        if (req.method === "GET")
          return send(res, 200, ".json", JSON.stringify({ creators: await wstore.listCreators(), configured: true, vendor: wl.vendorConfigured() }));
        if (req.method === "POST") {
          const body = await readJson(req);
          if (!body.username) return send(res, 400, ".json", JSON.stringify({ error: "username required" }));
          if (!wl.vendorConfigured()) return send(res, 200, ".json", JSON.stringify({ error: "Add HIKERAPI_KEY on the server to look up and sweep creators.", code: "NO_VENDOR" }));
          const out = await wl.addAndSweep(body.username, {
            region: body.region || null,
            igUserId: body.igUserId || null,
            fullName: body.fullName || null,
            followerCount: body.followerCount != null ? body.followerCount : null,
            avatar: body.avatar || null,
          });
          return send(res, 200, ".json", JSON.stringify(out));
        }
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }
    const wm = u.pathname.match(/^\/api\/watchlist\/([^/]+)$/);
    if (wm && req.method === "DELETE") {
      const wstore = await import("./lib/store/watchlist.mjs");
      try {
        return send(res, 200, ".json", JSON.stringify(await wstore.removeCreator(decodeURIComponent(wm[1]))));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // The Trending feed: ranked + filtered reels, audio clusters, format rollup.
    if (u.pathname === "/api/watch/feed" && req.method === "GET") {
      const wl = await import("./lib/watchlist.mjs");
      if (!wl.isConfigured())
        return send(res, 200, ".json", JSON.stringify({ items: [], clusters: [], formats: [], stats: {}, configured: false }));
      try {
        const p = u.searchParams;
        const num = (k) => (p.get(k) != null && p.get(k) !== "" ? Number(p.get(k)) : null);
        const feed = await wl.getFeed({
          sort: p.get("sort") || "velocity",
          minOutlier: num("minOutlier"), minVelocity: num("minVelocity"), minEngagement: num("minEngagement"),
          duration: p.get("duration") || null, sinceDays: num("sinceDays"),
          audioId: p.get("audioId") || null, creator: p.get("creator") || null, region: p.get("region") || null,
          collabOnly: p.get("collabOnly") === "1", limit: num("limit") || 60,
        });
        return send(res, 200, ".json", JSON.stringify({ ...feed, configured: true }));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // On-demand: any handle's last reels with in-batch outlier scores (not saved).
    if (u.pathname === "/api/watch/lookup" && req.method === "POST") {
      const wl = await import("./lib/watchlist.mjs");
      if (!wl.vendorConfigured())
        return send(res, 200, ".json", JSON.stringify({ error: "Add HIKERAPI_KEY on the server first.", code: "NO_VENDOR" }));
      try {
        const body = await readJson(req);
        if (!body.username) return send(res, 400, ".json", JSON.stringify({ error: "username required" }));
        return send(res, 200, ".json", JSON.stringify(await wl.lookupCreator({ username: body.username, igUserId: body.igUserId || null, followerCount: body.followerCount != null ? body.followerCount : null })));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Type-ahead account search (for the watchlist input suggestions dropdown).
    if (u.pathname === "/api/watch/search" && req.method === "GET") {
      const wl = await import("./lib/watchlist.mjs");
      if (!wl.vendorConfigured()) return send(res, 200, ".json", JSON.stringify({ results: [], code: "NO_VENDOR" }));
      try {
        const q = u.searchParams.get("q") || "";
        if (q.replace(/^@/, "").trim().length < 2) return send(res, 200, ".json", JSON.stringify({ results: [] }));
        return send(res, 200, ".json", JSON.stringify({ results: await wl.searchAccounts(q, { limit: 6 }) }));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // "Creators like @X": suggested/related accounts for a seed handle (or own account).
    if (u.pathname === "/api/watch/related" && req.method === "POST") {
      const wl = await import("./lib/watchlist.mjs");
      if (!wl.vendorConfigured())
        return send(res, 200, ".json", JSON.stringify({ error: "Add HIKERAPI_KEY on the server first.", code: "NO_VENDOR" }));
      try {
        const body = await readJson(req);
        let handle = body.username;
        if (!handle && body.self) handle = (currentScope() || {}).igAccount || null;   // "creators like my account"
        if (!handle) return send(res, 400, ".json", JSON.stringify({ error: "Type a handle, or connect Instagram to use ‘like my account’." }));
        return send(res, 200, ".json", JSON.stringify(await wl.relatedCreators({ username: handle, igUserId: body.igUserId || null })));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Personalized video feed: watched reels ranked by fit to THIS creator's content.
    if (u.pathname === "/api/watch/niche" && req.method === "GET") {
      const wl = await import("./lib/watchlist.mjs");
      if (!wl.isConfigured()) return send(res, 200, ".json", JSON.stringify({ items: [], configured: false }));
      try {
        return send(res, 200, ".json", JSON.stringify({ ...(await wl.nicheFeed()), configured: true }));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Niche recommendations: creators to watch, derived from your best performers.
    if (u.pathname === "/api/watch/recommend" && req.method === "GET") {
      const wl = await import("./lib/watchlist.mjs");
      if (!wl.isConfigured()) return send(res, 200, ".json", JSON.stringify({ recommendations: [], configured: false }));
      if (!wl.vendorConfigured()) return send(res, 200, ".json", JSON.stringify({ recommendations: [], code: "NO_VENDOR" }));
      try {
        return send(res, 200, ".json", JSON.stringify({ ...(await wl.recommendCreators()), configured: true }));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Manually kick a sweep of THIS creator's watchlist (background; returns now).
    if (u.pathname === "/api/watch/sweep" && req.method === "POST") {
      const wl = await import("./lib/watchlist.mjs");
      if (!wl.vendorConfigured())
        return send(res, 200, ".json", JSON.stringify({ error: "Add HIKERAPI_KEY on the server first.", code: "NO_VENDOR" }));
      const cid = currentCreatorId();
      runInScope({ creator: { id: cid } }, () => wl.sweepAll({ onStep: (s) => console.log("  [watch-sweep] " + s) })
        .then((r) => console.log(`  [watch-sweep] done: ${r.reels} reels across ${r.creators} creators`))
        .catch((e) => console.log("  [watch-sweep] failed:", e && e.message ? e.message : e)));
      return send(res, 200, ".json", JSON.stringify({ started: true }));
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
    // Lab: AI interpretation of the ledger (gpt-5.5) — what to act on / ignore.
    if (u.pathname === "/api/causal/interpret" && req.method === "GET") {
      const causal = await import("./lib/causal.mjs");
      if (!causal.isConfigured()) return send(res, 200, ".json", JSON.stringify({ configured: false, text: "" }));
      try {
        return send(res, 200, ".json", JSON.stringify(await causal.interpret({ outcome: u.searchParams.get("outcome") || "rate" })));
      } catch (e) {
        return send(res, 200, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e), text: "" }));
      }
    }
    // Lab: granular retention — how each feature affects the real per-second curve.
    if (u.pathname === "/api/causal/retention" && req.method === "GET") {
      const causal = await import("./lib/causal.mjs");
      if (!causal.isConfigured()) return send(res, 200, ".json", JSON.stringify({ configured: false, rows: [], n: 0 }));
      try {
        return send(res, 200, ".json", JSON.stringify(await causal.retentionInsights({})));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e), rows: [] }));
      }
    }
    // Lab: the reels that have a given feature value (for the click-through popup).
    if (u.pathname === "/api/causal/reels" && req.method === "GET") {
      const causal = await import("./lib/causal.mjs");
      if (!causal.isConfigured()) return send(res, 200, ".json", JSON.stringify({ configured: false, reels: [] }));
      try {
        return send(res, 200, ".json", JSON.stringify(await causal.reelsForFeature({
          feature: u.searchParams.get("feature"), value: u.searchParams.get("value"), outcome: u.searchParams.get("outcome") || "rate",
        })));
      } catch (e) {
        return send(res, 200, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e), reels: [] }));
      }
    }

    // Lab: second-by-second drop analysis — per-reel death moments (?shortcode=) or the
    // cross-reel patterns (hook survival, mid-video cliffs, which cuts cost retention).
    if (u.pathname === "/api/drops" && req.method === "GET") {
      const drops = await import("./lib/drops.mjs");
      if (!drops.isConfigured()) return send(res, 200, ".json", JSON.stringify({ configured: false }));
      try {
        const sc = u.searchParams.get("shortcode");
        return send(res, 200, ".json", JSON.stringify(sc ? (await drops.reelDrops(sc)) || { moments: [] } : await drops.dropPatterns()));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Lab: the attention model — gradient-boosted trees on the per-SECOND dataset
    // (exact retention × frame track × transcript), cross-validated by reel. Answers
    // "what on screen/said at a moment holds or loses viewers", with feature importance.
    if (u.pathname === "/api/attention" && req.method === "GET") {
      const att = await import("./lib/attention.mjs");
      if (!att.isConfigured()) return send(res, 200, ".json", JSON.stringify({ configured: false }));
      try {
        const now = Date.now();
        if (!global.__attCache || now - global.__attCache.at > 30 * 60 * 1000 || u.searchParams.get("force")) {
          global.__attCache = { at: now, data: await att.trainAttentionModel({}) };
        }
        return send(res, 200, ".json", JSON.stringify(global.__attCache.data));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Reel audit: one reel's measured elements vs the Lab's proven practices.
    if (u.pathname === "/api/audit" && req.method === "GET") {
      const audit = await import("./lib/audit.mjs");
      if (!audit.isConfigured()) return send(res, 200, ".json", JSON.stringify({ configured: false }));
      try {
        const out = await audit.reelAudit(u.searchParams.get("shortcode") || "");
        return send(res, 200, ".json", JSON.stringify(out || { checks: [] }));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e), checks: [] }));
      }
    }

    // Lab: hook analysis — the spoken opening line, classified deterministically (regex)
    // and contrasted on skip rate + 3s hold; includes every reel's opener verbatim.
    if (u.pathname === "/api/hooks" && req.method === "GET") {
      const hooks = await import("./lib/hooks.mjs");
      if (!hooks.isConfigured()) return send(res, 200, ".json", JSON.stringify({ configured: false }));
      try {
        return send(res, 200, ".json", JSON.stringify(await hooks.hookAnalysis()));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Lab: multivariate predictor / robust mode — what drives VIEWS, controlled for each
    // other + reel maturity, honestly cross-validated (leave-one-out). Content-only vs
    // +retention R² shows how much of views is the hook, not the topic.
    if (u.pathname === "/api/predict" && req.method === "GET") {
      const predict = await import("./lib/predict.mjs");
      if (!predict.isConfigured()) return send(res, 200, ".json", JSON.stringify({ configured: false }));
      try {
        const contentOnly = await predict.trainViewsModel({ withRetention: false });
        const withRet = await predict.trainViewsModel({ withRetention: true });
        const full = await predict.trainViewsModel({ withRetention: true, withEngagement: true });
        const skip = await predict.trainSkipModel();
        const likes = await predict.trainEngagementModel("like");
        const comments = await predict.trainEngagementModel("comment");
        return send(res, 200, ".json", JSON.stringify({ configured: true, n: full.n, meta: full.meta, contentR2: contentOnly.looR2, retentionR2: withRet.looR2, fullR2: full.looR2, medianErrorPct: full.medianErrorPct, drivers: full.drivers, skip, likes, comments, note: full.note }));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Animation storyboard: a script -> per-beat visual plan + Claude Design prompts.
    if (u.pathname === "/api/animate" && req.method === "POST") {
      const body = await readJson(req);
      try {
        const { storyboard } = await import("./lib/animate.mjs");
        return send(res, 200, ".json", JSON.stringify(await storyboard(body.script || "")));
      } catch (e) {
        return send(res, e && e.code === "NO_SCRIPT" ? 200 : 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e), code: e && e.code }));
      }
    }
    // Reverse-engineer an extracted reel into a frame-by-frame animation breakdown.
    if (u.pathname === "/api/animate/reel" && req.method === "POST") {
      const body = await readJson(req);
      try {
        let frames = body.frames, transcript = body.transcript;
        if ((!frames || !frames.length) && body.shortcode) {
          const f = path.join(ANALYSIS, body.shortcode + ".json");
          if (existsSync(f)) { const j = JSON.parse(readFileSync(f, "utf8")); frames = j.frames; transcript = j.transcript; }
        }
        const { breakdownReel } = await import("./lib/animate.mjs");
        return send(res, 200, ".json", JSON.stringify(await breakdownReel({ frames, transcript })));
      } catch (e) {
        return send(res, e && e.code === "NO_FRAMES" ? 200 : 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e), code: e && e.code }));
      }
    }
    // Render one frame's description into an actual HTML mockup (a picture).
    if (u.pathname === "/api/animate/frame" && req.method === "POST") {
      const body = await readJson(req);
      try {
        const { renderFrame } = await import("./lib/animate.mjs");
        let imageDataUrl = null;
        if (body.img) { const p = path.join(ANALYSIS, body.img); if (existsSync(p)) imageDataUrl = "data:image/jpeg;base64," + readFileSync(p).toString("base64"); }
        return send(res, 200, ".json", JSON.stringify({ html: await renderFrame(body.visual || "", { context: body.context || "", imageDataUrl }) }));
      } catch (e) {
        return send(res, e && e.code === "NO_VISUAL" ? 200 : 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Studio: RAG "what works" advisor (generate / refine, grounded in the reels).
    if (u.pathname === "/api/studio" && req.method === "POST") {
      const body = await readJson(req);
      try {
        const studio = await import("./lib/studio.mjs");
        if (!studio.isConfigured())
          return send(res, 200, ".json", JSON.stringify({ error: "Supabase not configured", configured: false }));
        // A refinement turn is durable style feedback — remember it so every FUTURE
        // generation honors it too (creator_prefs.style_notes, injected into the prompt).
        const hist = body.history || [];
        const last = hist[hist.length - 1];
        if (hist.length > 1 && last && last.role === "user" && last.content) {
          import("./lib/store/prefs.mjs").then((p) => p.addStyleNote(last.content)).catch(() => {});
        }
        const out = await studio.studioGenerate({ brief: body.brief || "", goal: body.goal || "likes", history: hist });
        return send(res, 200, ".json", JSON.stringify(out));
      } catch (e) {
        return send(res, e && e.code === "NO_DATA" ? 200 : 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e), code: e && e.code }));
      }
    }

    // Media-kit custom fields (tagline, pricing, contact) — per creator.
    if (u.pathname === "/api/prefs" && (req.method === "GET" || req.method === "PUT")) {
      const creator = await requireCreator(req);
      if (!creator) return send(res, 401, ".json", JSON.stringify({ error: "unauthenticated" }));
      enterScope({ creator });
      try {
        const prefs = await import("./lib/store/prefs.mjs");
        if (req.method === "PUT") {
          const body = await readJson(req);
          const mediakit = await prefs.saveMediakit(body.mediakit || {});
          return send(res, 200, ".json", JSON.stringify({ ok: true, mediakit }));
        }
        return send(res, 200, ".json", JSON.stringify(await prefs.getPrefs()));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Per-creator audience demographics (age / gender / country) via THEIR token.
    // Cached per creator for 12h — powers the media kit's audience section.
    if (u.pathname === "/api/audience" && req.method === "GET") {
      const creator = await requireCreator(req);
      if (!creator) return send(res, 401, ".json", JSON.stringify({ error: "unauthenticated" }));
      let igAuth = null;
      try { igAuth = await igAuthForCreator(creator.id); } catch { /* not connected */ }
      if (!igAuth || !igAuth.token) return send(res, 200, ".json", JSON.stringify({ available: false }));
      const key = "aud:" + creator.id;
      const hit = liveCache.get(key);
      if (hit && Date.now() - hit.t < 12 * 60 * 60 * 1000) return send(res, 200, ".json", JSON.stringify(hit.payload));
      try {
        const out = { available: true, breakdowns: {} };
        for (const b of ["age", "gender", "country"]) {
          const url = `https://graph.instagram.com/v21.0/me/insights?metric=follower_demographics&period=lifetime&timeframe=last_30_days&breakdown=${b}&metric_type=total_value&access_token=${encodeURIComponent(igAuth.token)}`;
          const r = await fetch(url).then((x) => x.json());
          const results = r && r.data && r.data[0] && r.data[0].total_value && r.data[0].total_value.breakdowns && r.data[0].total_value.breakdowns[0] && r.data[0].total_value.breakdowns[0].results;
          if (!Array.isArray(results) || !results.length) continue;
          let items = results.map((it) => ({ label: String((it.dimension_values && it.dimension_values[0]) || ""), value: Number(it.value) || 0 }));
          const total = items.reduce((s, it) => s + it.value, 0) || 1;
          items = items.map((it) => ({ ...it, pct: Math.round((it.value / total) * 1000) / 10 })).sort((a, b) => b.value - a.value);
          out.breakdowns[b] = b === "country" ? items.slice(0, 5) : items;
        }
        liveCache.set(key, { t: Date.now(), payload: out });
        return send(res, 200, ".json", JSON.stringify(out));
      } catch (e) {
        return send(res, 200, ".json", JSON.stringify({ available: false, error: e && e.message ? e.message : String(e) }));
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
    // Auto-fetch public views/likes for every posted clip (token-free, parallel).
    if (u.pathname === "/api/clippers/refresh-views" && req.method === "POST") {
      const mod = await import("./lib/store/clippers.mjs");
      if (!mod.isConfigured()) return send(res, 200, ".json", JSON.stringify({ configured: false }));
      try {
        const out = await mod.refreshAllViews();
        return send(res, 200, ".json", JSON.stringify(out));
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

    // Fetch a clip's public views/likes from its posted URL (YouTube/TikTok, token-free).
    const amr = u.pathname.match(/^\/api\/assignments\/([^/]+)\/refresh$/);
    if (amr && req.method === "POST") {
      const mod = await import("./lib/store/clippers.mjs");
      const id = decodeURIComponent(amr[1]);
      try {
        const body = await readJson(req);
        const url = body && body.url;
        if (!url) return send(res, 400, ".json", JSON.stringify({ error: "no posted URL" }));
        const { reelStats } = await import("./lib/analysis/download.mjs");
        const s = await reelStats(url);
        if (!s || (s.views == null && s.likes == null)) return send(res, 200, ".json", JSON.stringify({ error: "couldn't read that URL's public stats" }));
        const patch = { posted_url: url, status: "posted" };
        if (s.views != null) patch.views = s.views;
        if (s.likes != null) patch.likes = s.likes;
        if (s.comments != null) patch.comments = s.comments;
        const item = await mod.updateAssignment(id, patch);
        return send(res, 200, ".json", JSON.stringify({ item, stats: s }));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // YouTube OAuth: connect a clipper's channel + report connection status.
    if (u.pathname === "/api/youtube/status" && req.method === "GET") {
      const yt = await import("./lib/youtube.mjs");
      let connections = [];
      try { if (yt.isConfigured()) connections = await yt.listConnections(); } catch { /* ignore */ }
      return send(res, 200, ".json", JSON.stringify({ configured: yt.isConfigured(), connections }));
    }
    if (u.pathname === "/api/youtube/connect" && req.method === "GET") {
      const yt = await import("./lib/youtube.mjs");
      if (!yt.isConfigured())
        return send(res, 200, ".html", "<body style='font-family:sans-serif;padding:40px'><h3>YouTube isn't configured yet</h3><p>Add <code>YOUTUBE_CLIENT_ID</code> and <code>YOUTUBE_CLIENT_SECRET</code> to <code>.env</code>, then restart the dashboard.</p></body>");
      const redirectUri = "http://localhost:" + PORT + "/api/youtube/callback";
      res.writeHead(302, { Location: yt.authUrl(redirectUri, u.searchParams.get("clipper_id") || "") });
      return res.end();
    }
    if (u.pathname === "/api/youtube/callback" && req.method === "GET") {
      const yt = await import("./lib/youtube.mjs");
      const code = u.searchParams.get("code");
      const clipperId = u.searchParams.get("state") || null;
      const redirectUri = "http://localhost:" + PORT + "/api/youtube/callback";
      const page = (body) => send(res, 200, ".html", "<body style='font-family:sans-serif;padding:48px;background:#0b0b14;color:#fff'>" + body + "</body>");
      if (!code) return page("<h2>No authorization code returned.</h2>");
      try {
        const tok = await yt.exchangeCode(code, redirectUri);
        let ch = null;
        try { ch = await yt.myChannel(tok.access_token); } catch { /* channel optional */ }
        if (!tok.refresh_token) return page("<h2>Connected, but Google didn't return a refresh token.</h2><p>Remove the app's access at myaccount.google.com/permissions and connect again (it must prompt for consent).</p>");
        await yt.saveToken({ clipper_id: clipperId, channel_id: ch && ch.id, channel_title: ch && ch.title, refresh_token: tok.refresh_token, scope: tok.scope });
        return page("<h2>✅ YouTube connected" + (ch ? " — " + ch.title : "") + "</h2><p>You can close this tab and return to the dashboard.</p><script>setTimeout(function(){location='/'},1600)</script>");
      } catch (e) {
        return page("<h2>Connection failed</h2><pre>" + String(e && e.message || e) + "</pre>");
      }
    }
    // YouTube publish: upload a reel's saved mp4 to the clipper's channel as a Short.
    if (u.pathname === "/api/youtube/publish" && req.method === "POST") {
      const yt = await import("./lib/youtube.mjs");
      const clippers = await import("./lib/store/clippers.mjs");
      try {
        const body = await readJson(req);
        const { clipper_id, reel_shortcode } = body;
        if (!clipper_id || !reel_shortcode) return send(res, 400, ".json", JSON.stringify({ error: "clipper_id and reel_shortcode required" }));
        const refresh = await yt.getRefreshToken(clipper_id);
        if (!refresh) return send(res, 200, ".json", JSON.stringify({ error: "No connected YouTube channel for this clipper — click Connect first." }));
        // Prefer a full-quality original (originals/<shortcode>.mp4) over the
        // re-compressed Instagram download, to avoid double compression on YouTube.
        const orig = ["mp4", "mov", "m4v", "webm"].map((e) => path.join(__dirname, "originals", reel_shortcode + "." + e)).find((p) => existsSync(p));
        const filePath = orig || path.join(ANALYSIS, reel_shortcode, "reel.mp4");
        if (!existsSync(filePath)) return send(res, 200, ".json", JSON.stringify({ error: "No source video on disk for " + reel_shortcode + "." }));
        const access = await yt.accessFromRefresh(refresh);
        const hook = (body.title || reel_shortcode).slice(0, 95);
        // hashtags relevant to THIS video, generated from its own hook/summary
        let hashtags = body.hashtags;
        if (!hashtags) {
          try {
            const { getDb } = await import("./lib/store/supabase.mjs");
            const db = await getDb();
            const { data: reel } = await db.from("reels").select("hook, summary, transcript_text").eq("shortcode", reel_shortcode).maybeSingle();
            if (reel) hashtags = await yt.suggestHashtags(reel);
          } catch { /* fall back below */ }
        }
        hashtags = hashtags || "#KI #ChatGPT #Claude #KünstlicheIntelligenz #AI #Automatisierung #Shorts";
        const description = (body.description || hook) + "\n\n" + hashtags + "\n\n🤖 KI & Tech, einfach erklärt.";
        const tags = hashtags.split(/\s+/).map((t) => t.replace(/^#/, "")).filter(Boolean).slice(0, 12);
        const vid = await yt.uploadShort({ accessToken: access, filePath, title: hook, description, tags, privacy: body.privacy || "public" });
        const url = "https://www.youtube.com/shorts/" + vid.id;
        let aid = body.assignment_id;
        if (aid) await clippers.updateAssignment(aid, { status: "posted", posted_url: url, posted_at: new Date().toISOString() });
        else { const made = await clippers.createAssignments({ clipper_id, reel_shortcode, platform: "youtube" }); aid = made && made[0] && made[0].id; if (aid) await clippers.updateAssignment(aid, { status: "posted", posted_url: url, posted_at: new Date().toISOString() }); }
        return send(res, 200, ".json", JSON.stringify({ ok: true, videoId: vid.id, url, assignment_id: aid }));
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

    // cloudwalkeers marketing-site contact / demo request (public, no auth)
    if (u.pathname === "/api/contact" && req.method === "POST") {
      try {
        const body = await readJson(req);
        const email = String(body.email || "").trim();
        if (!email || !/.+@.+\..+/.test(email)) return send(res, 400, ".json", JSON.stringify({ error: "invalid email" }));
        const db = await getDb();
        const { error } = await db.from("cw_contacts").insert({
          name: body.name ? String(body.name).slice(0, 200) : null,
          email: email.slice(0, 300),
          message: body.message ? String(body.message).slice(0, 4000) : null,
          source: body.source ? String(body.source).slice(0, 60) : "web",
        });
        if (error) throw new Error(error.message);
        return send(res, 200, ".json", JSON.stringify({ ok: true }));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // ── cloudwalkeers: creator auth + per-creator platform connections ──────
    if (u.pathname === "/api/me") {
      const creator = await requireCreator(req);
      if (!creator) return send(res, 401, ".json", JSON.stringify({ error: "unauthenticated" }));
      return send(res, 200, ".json", JSON.stringify({ id: creator.id, email: creator.email }));
    }

    if (u.pathname === "/api/connections") {
      const creator = await requireCreator(req);
      if (!creator) return send(res, 401, ".json", JSON.stringify({ error: "unauthenticated" }));
      try {
        return send(res, 200, ".json", JSON.stringify({ connections: await listConnections(creator.id) }));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // Start (GET → returns the provider authorize URL) or remove (DELETE) a
    // platform connection. Auth via the creator's bearer token.
    const conn = u.pathname.match(/^\/api\/connect\/(instagram|tiktok|youtube)$/);
    if (conn) {
      const creator = await requireCreator(req);
      if (!creator) return send(res, 401, ".json", JSON.stringify({ error: "unauthenticated" }));
      const platform = conn[1];
      if (req.method === "DELETE") {
        try { await deleteConnection(creator.id, platform); return send(res, 200, ".json", JSON.stringify({ ok: true })); }
        catch (e) { return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) })); }
      }
      if (platform !== "instagram")
        return send(res, 501, ".json", JSON.stringify({ error: platform + " connect coming soon" }));
      try {
        const state = signState({ cid: creator.id, p: platform });
        return send(res, 200, ".json", JSON.stringify({ url: igOAuth.authorizeUrl(state) }));
      } catch (e) {
        return send(res, 500, ".json", JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
    }

    // OAuth callback — a top-level redirect from Instagram. The creator is carried
    // (HMAC-signed) in `state`, so no auth header is needed here.
    if (u.pathname === "/api/connect/instagram/callback") {
      const st = verifyState(u.searchParams.get("state"));
      const code = u.searchParams.get("code");
      if (u.searchParams.get("error") || !code || !st || st.p !== "instagram")
        return redirect(res, "/connect.html?connect=error");
      try {
        const tok = await igOAuth.exchangeCode(code);
        let profile = {};
        try { profile = await igOAuth.fetchProfile(tok.accessToken); } catch { /* non-fatal */ }
        await saveConnection(st.cid, "instagram", { ...tok, ...profile });
        // Auto-backfill: pull their reels + insights with their new token right away,
        // so the dashboard is populated by the time they open it. Fire-and-forget.
        runInScope(
          { creator: { id: st.cid }, igAccount: profile.username || null, igToken: tok.accessToken },
          () => fetchLivePayload()
            .then((p) => console.log("  [auto-sync] @" + (profile.username || "?") + ": " + ((p && p.defs && p.defs.length) || 0) + " reels"))
            .catch((e) => console.log("  [auto-sync] failed:", e && e.message ? e.message : e))
        );
        return redirect(res, "/connect.html?connected=instagram");
      } catch (e) {
        console.log("  [ig connect] " + (e && e.message ? e.message : e));
        return redirect(res, "/connect.html?connect=error");
      }
    }

    if (u.pathname === "/favicon.ico") return send(res, 204, ".ico", "");

    const rel = u.pathname === "/" ? "index.html"
      : (u.pathname === "/app" || u.pathname === "/dashboard") ? "app.html"
      : u.pathname === "/mediakit" ? "mediakit.html"
      : u.pathname.replace(/^\/+/, "");
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

// Background: keep the Instagram token alive (refresh well before the 60-day
// expiry). Runs shortly after boot, then daily — hands-off, best-effort.
(() => {
  const run = () => refreshIfNeeded()
    .then((r) => { if (r && r.refreshed) console.log("  [ig-token] refreshed — valid through " + r.expires); })
    .catch(() => {});
  setTimeout(run, 8000);
  setInterval(run, 24 * 60 * 60 * 1000);
})();

// Background: multi-tenant keepalive — renew EVERY creator's Instagram token well
// before its 60-day expiry (whether or not they log in), then re-sync each connected
// account's reels + insights so dashboards are fresh every morning without anyone
// clicking Sync. Daily, sequential (gentle on rate limits), best-effort.
(() => {
  const run = async () => {
    try {
      const conn = await import("./lib/oauth/connections.mjs");
      const r = await conn.refreshAllTokens({});
      if (r.total) console.log(`  [keepalive] tokens: ${r.refreshed} refreshed · ${r.ok} healthy · ${r.failed} need re-auth`);
      for (const c of await conn.listActiveIgConnections()) {
        await runInScope(
          { creator: { id: c.creator_id }, igAccount: c.username, igToken: c.access_token },
          () => fetchLivePayload()
            .then((p) => console.log(`  [nightly-sync] @${c.username}: ${(p && p.defs && p.defs.length) || 0} reels`))
            .catch((e) => console.log(`  [nightly-sync] @${c.username} failed:`, e && e.message ? e.message : e))
        );
      }
    } catch (e) { console.log("  [keepalive] skipped:", e && e.message ? e.message : e); }
  };
  setTimeout(run, 45000);                  // shortly after boot
  setInterval(run, 24 * 60 * 60 * 1000);   // then daily
})();

// Background: keep clipper clip views fresh, hands-off (token-free yt-dlp).
(async () => {
  try {
    const mod = await import("./lib/store/clippers.mjs");
    if (!mod.isConfigured()) return;
    const run = () => mod.refreshAllViews()
      .then((r) => { if (r && r.updated) console.log("  [clippers] auto-refreshed " + r.updated + " clip view counts"); })
      .catch(() => {});
    setTimeout(run, 25000);                 // shortly after boot
    setInterval(run, 3 * 60 * 60 * 1000);   // and every 3 hours
  } catch { /* clippers optional */ }
})();

// Background: sweep each workspace's own creator watchlist (Trending lane). Every pass
// snapshots each reel's view/like/comment counts so velocity (Δviews/hour) can be
// derived, and recomputes outlier/engagement. Runs per-tenant inside that creator's
// scope. Twice daily keeps vendor cost bounded (watched creators × sweeps). Best-effort.
(async () => {
  try {
    const wl = await import("./lib/watchlist.mjs");
    if (!wl.isConfigured() || !wl.vendorConfigured()) return;
    const wstore = await import("./lib/store/watchlist.mjs");
    const run = async () => {
      try {
        const tenants = await wstore.listTenantsWithWatchlist();
        let total = 0;
        for (const cid of tenants) {
          const r = await runInScope({ creator: { id: cid } }, () => wl.sweepAll({ onStep: () => {} }));
          total += (r && r.reels) || 0;
        }
        if (tenants.length) console.log(`  [watch-sweep] ${total} reels across ${tenants.length} workspaces`);
      } catch (e) { console.log("  [watch-sweep] skipped:", e && e.message ? e.message : e); }
    };
    setTimeout(run, 60000);                  // shortly after boot
    setInterval(run, 12 * 60 * 60 * 1000);   // twice daily
  } catch { /* trending lane optional */ }
})();

// Live Graph API pull → payload. Fast now: skips the per-reel duration probe using
// stored durations, fetches insights in parallel, and prefers local covers. Persists
// the snapshot (best-effort, non-blocking) so the stored view stays current.
async function fetchLivePayload() {
  let durations = null;
  try { const st = await import("./lib/store/stored.mjs"); if (st.isConfigured()) durations = await st.durationsByShortcode(); } catch { /* probe fallback */ }
  const raw = await collectReels({ max: Number(process.env.MAX_REELS || 60), durations });
  const payload = toPayload(raw, { source: "live" });
  try {
    const st = await import("./lib/store/stored.mjs");
    if (st.isConfigured()) {
      const sc = (u) => { const m = String(u || "").match(/\/reels?\/([^/?#]+)/i); return m ? m[1] : null; };
      const shorts = payload.defs.map((d) => sc(d.permalink));
      const thumbs = await st.localThumbs(shorts);
      const ins = await st.retentionByShortcode(shorts);
      payload.defs.forEach((d) => {
        const s = sc(d.permalink);
        if (s && thumbs[s]) d.thumb = thumbs[s];
        if (s && ins[s]) { if (ins[s].retention_curve) d.retentionCurve = ins[s].retention_curve; d.skipRate = ins[s].skip_rate; d.repostRate = ins[s].repost_rate; d.rateBenchmarks = ins[s].rate_benchmarks; }
      });
    }
  } catch { /* keep the CDN cover */ }
  // Persist covers: Instagram's CDN thumbnail URLs expire/hotlink-block, so save each
  // reel's cover once to the volume (analysis/thumbs/<shortcode>.jpg) and serve locally.
  try { await persistThumbs(payload.defs); } catch { /* covers are best-effort */ }
  liveCache.set(cacheKey(), { t: Date.now(), payload });
  // Remember the follower count on the creator's connection so stored-path views
  // (media kit, dashboard) can show it without an Instagram round-trip.
  if (currentCreatorId() && payload.meta && payload.meta.followers != null)
    saveFollowers(currentCreatorId(), "instagram", payload.meta.followers).catch(() => {});
  try {
    // Await the store (instead of fire-and-forget) so a creator's very first sync
    // is fully persisted before the dashboard reads it back.
    const m = await import("./lib/store/metrics.mjs");
    if (m.isConfigured()) {
      const r = await m.storeMetrics(payload);
      if (r && r.stored) console.log("  metrics → supabase:", r.stored, "reel(s),", r.failed, "failed");
    }
  } catch (e) { console.log("  metrics store skipped:", e && e.message ? e.message : e); }
  return payload;
}

async function getData(force, demo) {
  if (demo) return demoPayload();
  // Live pull. isConfigured()/fetchLivePayload are scope-aware: inside a web request
  // they run with the LOGGED-IN creator's own connected token (graph.instagram.com);
  // only the CLI/legacy path uses the env credentials.
  if (force && isConfigured()) {
    const hit = liveCache.get(cacheKey());
    if (hit && Date.now() - hit.t < CACHE_MS) return hit.payload; // de-dupe rapid refreshes
    try { return await fetchLivePayload(); }
    catch (e) { console.log("  live refresh failed:", e && e.message ? e.message : e); /* fall through to stored */ }
  }
  // Default: the REAL catalogue from Supabase, scoped to this creator's ig_account.
  try {
    const stored = await import("./lib/store/stored.mjs");
    if (stored.isConfigured()) {
      const payload = await stored.storedPayload({ account: currentIgAccount() });
      if (payload && payload.defs && payload.defs.length) {
        const rt = await realTrend(payload.defs); // real daily reach via the caller's own token
        if (rt) payload.trend = rt;
        if (isScoped()) {
          const sc = currentScope();
          payload.meta = { ...(payload.meta || {}), liveCapable: !!currentIgToken() };
          if (payload.meta.followers == null && sc && sc.igFollowers != null) payload.meta.followers = sc.igFollowers;
        }
        return payload;
      }
    }
  } catch (e) {
    console.log("  stored payload skipped:", e && e.message ? e.message : e);
  }
  // Nothing stored for this account yet → first-load auto-populate: one live pull
  // with whatever credentials the caller has (creator token when scoped).
  if (isConfigured()) { try { return await fetchLivePayload(); } catch { /* demo */ } }
  return demoPayload();
}

// Download reel covers to the persistent volume so the dashboard/media kit always
// have a working image (IG CDN links expire). Skips existing files; bounded concurrency.
async function persistThumbs(defs) {
  const { mkdirSync, existsSync: ex, createWriteStream } = await import("node:fs");
  const dir = path.join(ANALYSIS, "thumbs");
  mkdirSync(dir, { recursive: true });
  const scOf = (u) => { const m = String(u || "").match(/\/reels?\/([^/?#]+)/i); return m ? m[1] : null; };
  const jobs = [];
  for (const d of defs || []) {
    const sc = scOf(d.permalink);
    if (!sc) continue;
    const file = path.join(dir, sc + ".jpg");
    const local = "/analysis/thumbs/" + sc + ".jpg";
    if (ex(file)) { if (!d.thumb || /^https?:/.test(d.thumb)) d.thumb = local; continue; }
    const src = d.thumb && /^https?:/.test(d.thumb) ? d.thumb : null;
    if (!src) continue;
    jobs.push(async () => {
      try {
        const r = await fetch(src, { redirect: "follow" });
        if (!r.ok || !r.body) return;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 2000) return; // an error page, not an image
        await (await import("node:fs/promises")).writeFile(file, buf);
        d.thumb = local;
      } catch { /* keep whatever we had */ }
    });
  }
  let i = 0;
  const worker = async () => { while (i < jobs.length) { const j = jobs[i++]; await j(); } };
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
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

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
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
