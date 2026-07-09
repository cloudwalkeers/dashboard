// Per-creator platform connections (Instagram / TikTok / YouTube).
// Service-role only — NEVER import this into browser-shipped code: it reads and
// writes access tokens. The browser only ever sees the safe status from
// `listConnections` (no tokens), returned through the server API.
import { getDb } from "../store/supabase.mjs";

const TABLE = "platform_connections";

/**
 * Upsert a creator's connection for a platform.
 * @param {string} creatorId  auth.users id
 * @param {"instagram"|"tiktok"|"youtube"} platform
 * @param {object} data  { accessToken, refreshToken?, expiresAt?, externalId?, username?, accountType?, scopes?, status? }
 */
export async function saveConnection(creatorId, platform, data) {
  const db = await getDb();
  const row = {
    creator_id: creatorId,
    platform,
    external_id: data.externalId ?? null,
    username: data.username ?? null,
    account_type: data.accountType ?? null,
    access_token: data.accessToken ?? null,
    refresh_token: data.refreshToken ?? null,
    token_expires_at: data.expiresAt ?? null,
    scopes: data.scopes ?? null,
    status: data.status || "connected",
    updated_at: new Date().toISOString(),
  };
  const { error } = await db.from(TABLE).upsert(row, { onConflict: "creator_id,platform" });
  if (error) throw new Error("saveConnection: " + error.message);
}

/** Full row incl. tokens — server-side use only (e.g. to call the platform API). */
export async function getConnection(creatorId, platform) {
  const db = await getDb();
  const { data, error } = await db
    .from(TABLE).select("*")
    .eq("creator_id", creatorId).eq("platform", platform)
    .maybeSingle();
  if (error) throw new Error("getConnection: " + error.message);
  return data || null;
}

/** Safe connection status for the browser — no tokens. */
export async function listConnections(creatorId) {
  const db = await getDb();
  const { data, error } = await db
    .from(TABLE)
    .select("platform, username, account_type, status, connected_at, token_expires_at")
    .eq("creator_id", creatorId);
  if (error) throw new Error("listConnections: " + error.message);
  return data || [];
}

/** Remove a connection (creator disconnects a platform). */
export async function deleteConnection(creatorId, platform) {
  const db = await getDb();
  const { error } = await db.from(TABLE).delete().eq("creator_id", creatorId).eq("platform", platform);
  if (error) throw new Error("deleteConnection: " + error.message);
}

/** The creator's connected Instagram handle (or null) — used to scope their reel queries. */
export async function igAccountForCreator(creatorId) {
  const auth = await igAuthForCreator(creatorId);
  return auth ? auth.username : null;
}

/** The creator's Instagram auth for live API calls: { username, token } or null.
 *  Opportunistically renews the long-lived token when it's within 10 days of
 *  expiry (same +60d refresh the single-account tool used, now per creator). */
export async function igAuthForCreator(creatorId) {
  const db = await getDb();
  const { data, error } = await db
    .from(TABLE).select("username, access_token, token_expires_at, followers")
    .eq("creator_id", creatorId).eq("platform", "instagram").eq("status", "connected")
    .maybeSingle();
  if (error) throw new Error("igAuthForCreator: " + error.message);
  if (!data) return null;

  let token = data.access_token || null;
  const exp = data.token_expires_at ? Date.parse(data.token_expires_at) : 0;
  const daysLeft = exp ? (exp - Date.now()) / 86400000 : null;
  if (token && daysLeft != null && daysLeft < 10) {
    try {
      const { refreshToken } = await import("./instagram.mjs");
      const r = await refreshToken(token);
      token = r.accessToken;
      await db.from(TABLE)
        .update({ access_token: token, token_expires_at: r.expiresAt, updated_at: new Date().toISOString() })
        .eq("creator_id", creatorId).eq("platform", "instagram");
    } catch { /* keep the existing token; it may still work */ }
  }
  return { username: data.username || null, token, followers: data.followers ?? null };
}

/** Persist the last-known follower count (refreshed by every live sync). */
export async function saveFollowers(creatorId, platform, followers) {
  if (followers == null) return;
  const db = await getDb();
  await db.from(TABLE)
    .update({ followers: Number(followers) || 0, updated_at: new Date().toISOString() })
    .eq("creator_id", creatorId).eq("platform", platform);
}
