// YouTube integration (zero-dep, raw HTTPS). OAuth 2.0 connect per clipper
// channel + helpers to read stats and (next) upload Shorts. Client ID/Secret
// come from .env; refresh tokens are stored server-side in oauth_tokens and
// never sent to the browser.
import https from "node:https";
import { createReadStream, statSync } from "node:fs";
import { getDb } from "./store/supabase.mjs";

const CID = () => process.env.YOUTUBE_CLIENT_ID || "";
const CSEC = () => process.env.YOUTUBE_CLIENT_SECRET || "";
export function isConfigured() { return !!(CID() && CSEC()); }

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

export function authUrl(redirectUri, state) {
  const p = new URLSearchParams({
    client_id: CID(), redirect_uri: redirectUri, response_type: "code",
    scope: SCOPES.join(" "), access_type: "offline", prompt: "consent",
    include_granted_scopes: "true", state: state || "",
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
}

function postForm(host, path, form) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const req = https.request({ host, path, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => { try { const j = JSON.parse(d); r.statusCode >= 400 ? reject(new Error(j.error_description || j.error || d)) : resolve(j); } catch { reject(new Error(d.slice(0, 300))); } });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ host: u.host, path: u.pathname + u.search, method: "GET", headers: headers || {} }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => { try { const j = JSON.parse(d); r.statusCode >= 400 ? reject(new Error((j.error && j.error.message) || d)) : resolve(j); } catch { reject(new Error(d.slice(0, 300))); } });
    });
    req.on("error", reject); req.end();
  });
}

export async function exchangeCode(code, redirectUri) {
  return postForm("oauth2.googleapis.com", "/token", { code, client_id: CID(), client_secret: CSEC(), redirect_uri: redirectUri, grant_type: "authorization_code" });
}
export async function accessFromRefresh(refreshToken) {
  const j = await postForm("oauth2.googleapis.com", "/token", { refresh_token: refreshToken, client_id: CID(), client_secret: CSEC(), grant_type: "refresh_token" });
  return j.access_token;
}
export async function myChannel(accessToken) {
  const j = await getJson("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { Authorization: "Bearer " + accessToken });
  const c = j.items && j.items[0];
  return c ? { id: c.id, title: c.snippet && c.snippet.title } : null;
}

// ── token storage (server-side only) ──────────────────────────────────────
export async function saveToken({ clipper_id, channel_id, channel_title, refresh_token, scope }) {
  const db = await getDb();
  const { error } = await db.from("oauth_tokens").upsert(
    { provider: "youtube", clipper_id, channel_id, channel_title, refresh_token, scope, updated_at: new Date().toISOString() },
    { onConflict: "provider,clipper_id" });
  if (error) throw new Error("saveToken: " + error.message);
}
/** Connections WITHOUT the secret token — safe to send to the client. */
export async function listConnections() {
  const db = await getDb();
  const { data } = await db.from("oauth_tokens").select("clipper_id, channel_id, channel_title, updated_at").eq("provider", "youtube");
  return data || [];
}
export async function getRefreshToken(clipperId) {
  const db = await getDb();
  const { data } = await db.from("oauth_tokens").select("refresh_token").eq("provider", "youtube").eq("clipper_id", clipperId).maybeSingle();
  return data && data.refresh_token;
}

// ── publish: resumable upload of a local mp4 as a (Shorts-eligible) video ───
export async function uploadShort({ accessToken, filePath, title, description = "", tags = [], privacy = "public" }) {
  const meta = JSON.stringify({
    snippet: { title: (title || "Reel").slice(0, 100), description, tags, categoryId: "28" }, // 28 = Science & Technology
    status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
  });
  const size = statSync(filePath).size;
  // 1) open a resumable session — Google returns the upload URL in the Location header
  const sessionUrl = await new Promise((resolve, reject) => {
    const r = https.request({
      host: "www.googleapis.com",
      path: "/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      method: "POST",
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json; charset=UTF-8", "Content-Length": Buffer.byteLength(meta), "X-Upload-Content-Type": "video/*", "X-Upload-Content-Length": size },
    }, (resp) => { let d = ""; resp.on("data", (c) => (d += c)); resp.on("end", () => { (resp.statusCode === 200 && resp.headers.location) ? resolve(resp.headers.location) : reject(new Error("start upload " + resp.statusCode + ": " + d.slice(0, 240))); }); });
    r.on("error", reject); r.write(meta); r.end();
  });
  // 2) stream the bytes
  const su = new URL(sessionUrl);
  return new Promise((resolve, reject) => {
    const r = https.request({ host: su.host, path: su.pathname + su.search, method: "PUT", headers: { "Content-Length": size, "Content-Type": "video/*" } },
      (resp) => { let d = ""; resp.on("data", (c) => (d += c)); resp.on("end", () => { try { const j = JSON.parse(d); (resp.statusCode >= 200 && resp.statusCode < 300) ? resolve(j) : reject(new Error("upload " + resp.statusCode + ": " + ((j.error && j.error.message) || d.slice(0, 240)))); } catch { reject(new Error("upload failed " + resp.statusCode)); } }); });
    r.on("error", reject);
    createReadStream(filePath).pipe(r);
  });
}
