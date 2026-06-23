# Reels Dashboard

A local, zero-dependency dashboard that consolidates your Instagram Reels insights
from the Meta Graph API. It runs entirely on your machine — no build step, no
framework install. Ships with a **demo dataset** so it works the moment you start it,
and switches to your **live** data once you add credentials.

```
node server.mjs        # → http://localhost:5173
```

If no `.env` is present it serves demo data; the header shows a "Demo data" badge.

---

## What you get

**Overview**
- KPI cards: reach, plays, avg watch, watch-through, engagement rate, follows — with
  a 7/30/90-day range selector and "vs previous period" deltas.
- Daily reach & plays trend chart.
- Engagement mix (likes / saves / shares / comments).
- Auto-generated "what's working / needs attention" insights.
- Sortable table of every reel.

**Per-reel detail** (click any reel)
- Headline KPIs vs. your account average.
- Audience-retention curve, drop-off heatmap, and key moments.
- Engagement breakdown by type.

---

## Going live

1. Copy the env template and fill in the two required values:
   ```
   cp .env.example .env
   ```
   | Variable           | What it is                                                                 |
   | ------------------ | -------------------------------------------------------------------------- |
   | `IG_USER_ID`       | Your Instagram **Business/Creator** account id (a long number, not @handle). |
   | `IG_ACCESS_TOKEN`  | A long-lived token with the scopes listed below.                            |

   Optional: `GRAPH_VERSION` (default `v21.0`), `MAX_REELS` (default `40`), `PORT` (default `5173`).

2. Required token scopes:
   `instagram_basic`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`

3. Restart `node server.mjs`. The startup banner will read **LIVE Instagram data** and the
   header badge turns green.

### Getting the credentials (high level)
- Connect your Instagram account to a Facebook Page, and create a Meta app at
  developers.facebook.com.
- Use the Graph API Explorer (or your app's login flow) to mint a token with the scopes
  above, then exchange it for a **long-lived** token (~60 days).
- Find your IG user id via `GET /me/accounts` → the page's `instagram_business_account.id`.

---

## How the data is sourced

| Field in the dashboard | Source |
| ---------------------- | ------ |
| reach, plays, likes, comments, shares, saves | Graph API per-reel `insights` |
| reel **length** | Read from the reel's own `.mp4` (`media_url`) — the `mvhd` atom — no ffmpeg ([lib/mp4duration.mjs](lib/mp4duration.mjs)) |
| avg watch / watch-through | real `ig_reels_avg_watch_time` ÷ real length |
| daily reach & plays trend | account-level `insights` (90-day window) |

**Modeled / estimated:**
- **Per-second retention curve, drop-off heatmap, and "biggest drop" moment** — the Graph
  API does **not** expose per-second retention. The detail view estimates a decay curve
  whose average matches your real average watch time, and labels it as estimated.
- **Per-reel follows** — the API can't attribute new follows to a single reel (shows `n/a`
  on live data; the demo dataset includes synthetic values).

Live responses are cached for 5 minutes. Click the sync status in the header (or load
`/api/data?refresh=1`) to force a refresh. Append `?demo=1` to preview the demo dataset.

---

## AI breakdown (frame-by-frame visuals + transcript + analysis)

A per-reel pipeline that extracts frames + audio, describes each frame, transcribes the
speech, and produces timestamped, actionable analysis. It appears as the **AI breakdown**
panel in a reel's detail view, and feeds the Remotion videos below.

```
npm install                                              # one-time: ffmpeg-static + openai
npm run analyze -- <reel.mp4 | https-url> --id <name>    # full run
npm run analyze -- <reel.mp4> --id <name> --dry-run      # frames + JSON only (no API calls)
npm run analyze -- <reel.mp4> --id <name> --reuse        # keep frame descriptions, redo transcript + analysis only
```

Output: `analysis/<id>.json` (+ extracted `analysis/<id>/frames/*.jpg`), served by the
dashboard at `/api/reel/<id>/analyze`.

| Step | Tool | Cost | Needs |
| ---- | ---- | ---- | ----- |
| frames + audio | ffmpeg (`ffmpeg-static`, bundled) | free | — |
| transcript | **OpenAI Whisper** (`whisper-1`) | ~$0.006/min | `OPENAI_API_KEY` + audio-model access on the project |
| per-frame description | **OpenAI vision** (`gpt-4.1`) | ~$0.04/reel | `OPENAI_API_KEY` |
| analysis | **OpenAI** (`gpt-4.1`) | a few cents | `OPENAI_API_KEY` |

Add to `.env`:
```
OPENAI_API_KEY=sk-...
# optional model overrides (defaults shown):
OPENAI_VISION_MODEL=gpt-4.1
OPENAI_ANALYSIS_MODEL=gpt-4.1
OPENAI_TRANSCRIBE_MODEL=whisper-1
```
Transcription needs the transcription model enabled for **the project your key belongs to**
(a 403 `model_not_found` for `whisper-1` means it isn't). If audio access is missing,
transcription is skipped and everything else still runs. Frame descriptions and the transcript
are real; only the dashboard's retention curve is estimated.

**Downloading a reel:** `media_url` (owned media, Graph API) or any direct `.mp4` URL works
with `--metrics`. An Instagram *page* URL is not a video file — fetch the mp4 first with a
tool like `yt-dlp` (`pip install yt-dlp; yt-dlp -o reel.mp4 "<reel-url>"`), then analyze the
local file. `media_url` links expire, so process promptly.

---

## Remotion videos (`remotion/`)

Renders two MP4s from an `analysis/<id>.json`. Separate sub-project (its own heavy toolchain),
so it stays out of the zero-dependency dashboard.

```
cd remotion && npm install
npm run studio                       # preview both compositions in the browser
npm run render:recap                 # RecapVideo → out/recap.mp4 (no source video needed)
npm run render:overlay               # AnnotatedReel → out/annotated.mp4
```
- **AnnotatedReel** — the reel itself with the retention curve, drop-off markers, current
  frame note, and live transcript overlaid. Put the reel at `remotion/public/reel.mp4`
  (or pass `--props='{"videoUrl":"...","data":...}'`).
- **RecapVideo** — a branded performance recap (KPIs + top suggestions), no source video.

Feed real data: `remotion render RecapVideo out/recap.mp4 --props=../analysis/<id>.json`.

---

## Project layout

```
server.mjs            Tiny static + /api/data server, .env loader, 5-min cache
lib/graph.mjs         Graph API client (media, insights, account trend)
lib/transform.mjs     Raw Graph responses → the flat payload the UI renders
lib/demo.mjs          Demo dataset (identical shape to live)
lib/mp4duration.mjs   Pure-Node MP4 duration probe
public/index.html     The dashboard (a dc-runtime Design Component)
public/support.js     The dc-runtime that renders it

lib/analysis/         AI pipeline: frames → transcript → vision → analysis
bin/analyze-reel.mjs  CLI runner  (npm run analyze)
remotion/             Remotion sub-project: annotated-overlay + recap video
```

The front-end is a **Design Component**: `public/index.html` holds an `<x-dc>` template
plus a `Component` logic class that fetches `/api/data` and maps it to the view.
`public/support.js` is the dc-runtime that compiles and renders it (React, loaded from CDN).
Requires an internet connection on first paint to fetch React.
