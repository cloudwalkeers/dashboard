# Deploying cloudwalkeers to Railway (cloudwalkeers.com)

The app runs as a normal always-on Node server (not serverless), which is why it
goes on Railway rather than Vercel. Docker image = Node + Python/yt-dlp + ffmpeg.

## 1. Get the branch on GitHub
Railway deploys from a branch. Push the `cloudwalkeers` branch to your repo
(`lucasdeschenes/gpt-marlon`):
```
git push personal cloudwalkeers
```

## 2. Create the Railway service
1. railway.app → **New Project → Deploy from GitHub repo** → pick the repo.
2. In the service **Settings**, set the deploy branch to `cloudwalkeers`.
   Railway auto-detects the `Dockerfile` (config is in `railway.json`).

## 3. Add a volume (so extractions persist)
Service → **Volumes → New Volume**, mount path: `/app/analysis`.

## 4. Set environment variables
Service → **Variables** → add:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://topypyboyyvykdfbxqmj.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | *(from your .env)* |
| `SUPABASE_PROJECT_ID` | `topypyboyyvykdfbxqmj` |
| `OPENAI_API_KEY` | *(from your .env)* |
| `IG_APP_ID` | Instagram App ID (Meta) |
| `IG_APP_SECRET` | Instagram App Secret (Meta) |
| `IG_OAUTH_REDIRECT` | `https://cloudwalkeers.com/api/connect/instagram/callback` |
| `IG_USER_ID` | *(existing — keeps the current data pipeline running)* |
| `IG_ACCESS_TOKEN` | *(existing single-account token, same reason)* |

`PORT`, `NODE_ENV`, `PYTHON_BIN` are handled automatically (Railway sets PORT; the
Dockerfile sets the others). `CW_OAUTH_STATE_SECRET` is optional (defaults to the
service-role key).

## 5. Point cloudwalkeers.com at Railway
Service → **Settings → Networking → Custom Domain** → add `cloudwalkeers.com`
(and `www` if you want). Railway shows a DNS record — add it at your registrar:
- **www** → `CNAME` to the target Railway shows.
- **apex** (`cloudwalkeers.com`) → your registrar's `ALIAS`/`ANAME` to that target,
  or move DNS to Cloudflare (which allows CNAME-at-apex flattening).

The `https://cloudwalkeers.com/api/connect/instagram/callback` redirect you already
registered in Meta will then resolve — the connect flow works in production.

## Notes / follow-ups
- **Meta App Review**: your own `@gptmarlon` (a tester) can connect immediately.
  For *any* creator to connect, the Meta app needs Advanced Access review +
  business verification + a public privacy policy. (Flagged separately.)
- **Per-creator data scoping** is the next dev step. Right now the dashboard still
  reads the single-account catalogue (`IG_ACCESS_TOKEN`); the Connect flow already
  stores per-creator tokens, and scoping wires the dashboard to use them.
- **Video rendering** (Remotion) is a separate project, not part of this server; it
  can become a dedicated worker later if you want cloud rendering.
