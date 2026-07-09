// Instagram OAuth — "Instagram API with Instagram Login".
// A creator connects their own IG professional account via a normal login+approve
// on Instagram's page (we never see their password). We receive a code, exchange it
// for a long-lived (~60-day) token, and store it per creator. The token self-refreshes
// — the same mechanism the single-account tool already uses, generalized per creator.
const IG_GRAPH = "graph.instagram.com";
const IG_AUTHORIZE = "https://www.instagram.com/oauth/authorize";
const IG_TOKEN = "https://api.instagram.com/oauth/access_token";

// insights + basic profile/media for the creator's own account
export const IG_SCOPES = ["instagram_business_basic", "instagram_business_manage_insights"];

function cfg() {
  const clientId = process.env.IG_APP_ID;
  const clientSecret = process.env.IG_APP_SECRET;
  const redirectUri = process.env.IG_OAUTH_REDIRECT;
  if (!clientId || !clientSecret || !redirectUri)
    throw new Error("Instagram OAuth not configured: set IG_APP_ID, IG_APP_SECRET, IG_OAUTH_REDIRECT");
  return { clientId, clientSecret, redirectUri };
}

/** Step 1 — where "Connect Instagram" sends the creator. `state` is a CSRF nonce. */
export function authorizeUrl(state) {
  const { clientId, redirectUri } = cfg();
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: IG_SCOPES.join(","),
    state: state || "",
  });
  return `${IG_AUTHORIZE}?${p.toString()}`;
}

/** Step 2 — exchange the returned code for a long-lived token (~60 days). */
export async function exchangeCode(code) {
  const { clientId, clientSecret, redirectUri } = cfg();
  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });
  const short = await fetch(IG_TOKEN, { method: "POST", body: form }).then((r) => r.json());
  if (!short.access_token)
    throw new Error("IG code exchange failed: " + (short.error_message || JSON.stringify(short)));

  const longUrl = `https://${IG_GRAPH}/access_token?grant_type=ig_exchange_token`
    + `&client_secret=${encodeURIComponent(clientSecret)}&access_token=${encodeURIComponent(short.access_token)}`;
  const long = await fetch(longUrl).then((r) => r.json());
  if (!long.access_token) throw new Error("IG long-lived exchange failed: " + JSON.stringify(long));

  return {
    accessToken: long.access_token,
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null,
    externalId: short.user_id != null ? String(short.user_id) : null,
    scopes: IG_SCOPES.join(","),
  };
}

/** Refresh a long-lived token (valid once it is >24h old). Returns the new token. */
export async function refreshToken(token) {
  const r = await fetch(
    `https://${IG_GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`
  ).then((x) => x.json());
  if (!r.access_token) throw new Error("IG token refresh failed: " + JSON.stringify(r));
  return {
    accessToken: r.access_token,
    expiresAt: r.expires_in ? new Date(Date.now() + r.expires_in * 1000).toISOString() : null,
  };
}

/** Who did we just connect? (account id, @handle, BUSINESS/CREATOR type). */
export async function fetchProfile(token) {
  const r = await fetch(
    `https://${IG_GRAPH}/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(token)}`
  ).then((x) => x.json());
  if (r.error) throw new Error("IG profile fetch failed: " + r.error.message);
  return {
    externalId: r.user_id != null ? String(r.user_id) : null,
    username: r.username || null,
    accountType: r.account_type || null,
  };
}
