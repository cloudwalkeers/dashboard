// Signed, short-lived OAuth `state`. The connect callback is a top-level redirect
// from the platform (no auth header), so we carry the creator id inside `state`,
// HMAC-signed so it can't be forged. Doubles as CSRF protection.
import { createHmac, timingSafeEqual } from "node:crypto";

function key() {
  // Dedicated secret if set, else reuse the service-role key (server-side only).
  return process.env.CW_OAUTH_STATE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "dev-insecure-secret";
}

export function signState(payload, ttlSec = 600) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const data = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = createHmac("sha256", key()).update(data).digest("base64url");
  return data + "." + sig;
}

export function verifyState(state) {
  if (typeof state !== "string" || !state.includes(".")) return null;
  const [data, sig] = state.split(".");
  const expected = createHmac("sha256", key()).update(data).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let body;
  try { body = JSON.parse(Buffer.from(data, "base64url").toString("utf8")); } catch { return null; }
  if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}
