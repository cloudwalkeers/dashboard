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
