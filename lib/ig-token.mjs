// Keeps the Instagram-login access token alive. Long-lived IG tokens last ~60
// days but can be refreshed for another 60 (any time the token is 24h–60d old).
// We persist the current token to _ig_token.json (gitignored) and refresh it
// well before expiry — so you paste the token once and it renews itself forever.
//
// Only applies to the Instagram-login API (GRAPH_HOST=graph.instagram.com); it's
// a no-op on the Facebook-login Graph API (those tokens refresh differently).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const STORE = path.join(process.cwd(), "_ig_token.json");
const DAY = 86400000;
const ASSUMED_LIFETIME = 60 * DAY; // a fresh long-lived token ≈ 60 days
const REFRESH_WINDOW = 10 * DAY;   // refresh once ≤10 days from expiry
const MIN_AGE = DAY;               // IG rejects a refresh on a <24h-old token

function read() { try { return JSON.parse(readFileSync(STORE, "utf8")); } catch { return null; } }
function write(o) { try { writeFileSync(STORE, JSON.stringify(o, null, 2)); return true; } catch { return false; } }
function onInstagramHost() { return (process.env.GRAPH_HOST || "").includes("graph.instagram.com"); }
const envToken = () => process.env.IG_ACCESS_TOKEN || process.env.ACCESS_TOKEN || "";

/** Boot: adopt the persisted (already-refreshed) token if we have one; otherwise
 *  seed the store from the .env token. Leaves process.env.IG_ACCESS_TOKEN current.
 *  If you paste a NEW token into .env, it's detected and reseeds automatically. */
export function loadToken() {
  if (!onInstagramHost()) return null;
  const env = envToken();
  const st = read();
  if (st && st.token) {
    if (env && st.seed && env !== st.seed) return seed(env); // .env token changed → reseed
    process.env.IG_ACCESS_TOKEN = st.token;                  // use the latest refreshed token
    return st;
  }
  return env ? seed(env) : null;
}

function seed(token) {
  const o = { token, seed: token, seeded_at: Date.now(), expires_at: Date.now() + ASSUMED_LIFETIME };
  write(o);
  process.env.IG_ACCESS_TOKEN = token;
  return o;
}

/** Refresh the token if it's inside the refresh window. Best-effort; never throws. */
export async function refreshIfNeeded() {
  if (!onInstagramHost()) return { skipped: "not instagram-login" };
  let st = read() || loadToken();
  if (!st || !st.token) return { skipped: "no token" };
  const now = Date.now();
  const age = now - (st.seeded_at || st.refreshed_at || now);
  const untilExpiry = (st.expires_at || 0) - now;
  if (untilExpiry > REFRESH_WINDOW) return { skipped: "not due", daysLeft: Math.round(untilExpiry / DAY) };
  if (age < MIN_AGE) return { skipped: "token too new (<24h)" };
  try {
    const url = "https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=" + encodeURIComponent(st.token);
    const j = await (await fetch(url)).json();
    if (!j.access_token) return { error: (j.error && j.error.message) || "no access_token returned" };
    const next = {
      token: j.access_token, seed: st.seed || st.token,
      seeded_at: st.seeded_at || now, refreshed_at: now,
      expires_at: now + (Number(j.expires_in) ? Number(j.expires_in) * 1000 : ASSUMED_LIFETIME),
    };
    write(next);
    process.env.IG_ACCESS_TOKEN = next.token;
    return { refreshed: true, expires: new Date(next.expires_at).toISOString().slice(0, 10) };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
}
