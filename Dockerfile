# cloudwalkeers — the reels app as a deployable service.
# The web server needs: Node, Python + yt-dlp (reel extraction), and ffmpeg
# (bundled by the ffmpeg-static npm package, so no apt install needed).
FROM node:22-bookworm-slim

# yt-dlp runs as a Python module: `python -m yt_dlp`. Install Python + yt-dlp.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PYTHON_BIN=python3 \
    PORT=8080 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# Install deps first for better layer caching. (Downloads the linux ffmpeg binary
# via ffmpeg-static's postinstall.)
COPY package*.json ./
RUN npm ci --omit=dev

# App source (see .dockerignore for what's excluded — secrets, node_modules, artifacts).
COPY . .

# Writable dirs for extraction artifacts. Mount a Railway volume at /app/analysis
# so extracted frames/transcripts survive redeploys.
RUN mkdir -p /app/analysis /app/originals

# App listens on PORT (set to 8080 above) to match the Railway domain's target port.
EXPOSE 8080
CMD ["node", "server.mjs"]
