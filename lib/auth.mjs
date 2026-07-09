// Server-side creator identity. The browser authenticates with Supabase Auth and
// sends its access token (Authorization: Bearer … or a cw_token cookie). We validate
// that token with Supabase and resolve the creator — their id becomes the tenant key
// (creator_id) every query is scoped to. Service-role only.
import { getDb } from "./store/supabase.mjs";

/** Validate a Supabase JWT → { id, email } or null. */
export async function creatorFromToken(accessToken) {
  if (!accessToken) return null;
  const db = await getDb();
  const { data, error } = await db.auth.getUser(accessToken);
  if (error || !data || !data.user) return null;
  return { id: data.user.id, email: data.user.email || null };
}

/** Pull the bearer token from a Node request (Authorization header or cw_token cookie). */
export function tokenFromRequest(req) {
  const auth = req.headers["authorization"] || req.headers["Authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const cookie = req.headers["cookie"] || "";
  const m = cookie.match(/(?:^|;\s*)cw_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Resolve the logged-in creator for a request, or null if unauthenticated. */
export async function requireCreator(req) {
  // Local-dev only: CW_DEV_FAKE_CREATOR=<auth.users id> short-circuits auth so the
  // dashboard can be exercised/screenshotted without a browser session. Never set
  // this in a deployed environment.
  if (process.env.CW_DEV_FAKE_CREATOR) return { id: process.env.CW_DEV_FAKE_CREATOR, email: "dev@localhost" };
  return creatorFromToken(tokenFromRequest(req));
}
