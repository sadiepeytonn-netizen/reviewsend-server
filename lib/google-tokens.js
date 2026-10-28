// Google connection keys live in the private business_google_tokens table,
// which only this server (service key) can read. The browser never sees them.

const { sbAdmin } = require("./access");

const enc = encodeURIComponent;
const LEGACY = () => process.env.LEGACY_MODE === "true";

async function googleTokenRequest(params) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });
  return res.json();
}

async function saveTokens(businessId, { access_token, refresh_token, expires_in }) {
  const row = {
    business_id: businessId,
    access_token,
    token_expiry: Date.now() + (Number(expires_in) || 3600) * 1000,
    updated_at: new Date().toISOString(),
  };
  // Google only sends a refresh token on the first consent; keep the old one otherwise.
  if (refresh_token) row.refresh_token = refresh_token;
  await sbAdmin(`/rest/v1/business_google_tokens?on_conflict=business_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: [row],
  });
}

async function readTokens(businessId) {
  const rows = await sbAdmin(`/rest/v1/business_google_tokens?business_id=eq.${enc(businessId)}&select=*`);
  if (rows && rows[0]) return rows[0];
  if (!LEGACY()) return null;
  // During the switch-over the old app may still have saved keys on the
  // businesses row. Move them into the private table the first time we see them.
  try {
    const biz = await sbAdmin(`/rest/v1/businesses?id=eq.${enc(businessId)}&select=google_access_token,google_refresh_token,google_token_expiry`);
    const b = biz && biz[0];
    if (!b || (!b.google_access_token && !b.google_refresh_token)) return null;
    const row = { business_id: businessId, access_token: b.google_access_token, refresh_token: b.google_refresh_token, token_expiry: b.google_token_expiry, updated_at: new Date().toISOString() };
    await sbAdmin(`/rest/v1/business_google_tokens?on_conflict=business_id`, {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: [row],
    });
    return row;
  } catch {
    return null; // old columns already removed
  }
}

// Returns a working access token for this business, refreshing it if it is
// about to expire. Throws an error with .needsReconnect when Google says the
// connection itself is no longer valid.
async function getValidAccessToken(businessId) {
  const t = await readTokens(businessId);
  if (!t || (!t.access_token && !t.refresh_token)) {
    const err = new Error("This business hasn't connected Google yet.");
    err.needsReconnect = true;
    throw err;
  }
  const fiveMinutes = 5 * 60 * 1000;
  if (t.access_token && t.token_expiry && Date.now() < Number(t.token_expiry) - fiveMinutes) return t.access_token;
  if (!t.refresh_token) return t.access_token;

  const data = await googleTokenRequest({ refresh_token: t.refresh_token, grant_type: "refresh_token" });
  if (data.error) {
    const err = new Error(data.error === "invalid_grant"
      ? "The Google connection needs to be reconnected (access was revoked or expired)."
      : (data.error_description || data.error));
    err.needsReconnect = data.error === "invalid_grant";
    throw err;
  }
  await saveTokens(businessId, data);
  return data.access_token;
}

async function exchangeCode(code, redirectUri) {
  return googleTokenRequest({ code, redirect_uri: redirectUri, grant_type: "authorization_code" });
}

async function deleteTokens(businessId) {
  await sbAdmin(`/rest/v1/business_google_tokens?business_id=eq.${enc(businessId)}`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  });
}

module.exports = { googleTokenRequest, saveTokens, readTokens, getValidAccessToken, exchangeCode, deleteTokens };
