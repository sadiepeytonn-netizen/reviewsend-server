const Sentry = require("@sentry/node");
const express = require("express");
const twilio = require("twilio");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const { sbAdmin, getAccess, isStaff, requireUser, requireBusiness, requireStaff, lower } = require("./lib/access");
const tokens = require("./lib/google-tokens");
const google = require("./lib/google-api");
const { inviteEmailHtml } = require("./lib/invite-email");

// ── SENTRY ────────────────────────────────────────────────────────────────────
// Sentry v8: init must happen before anything else, no Handlers.requestHandler needed
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || "production",
  tracesSampleRate: 0.2,
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────
// LEGACY_MODE=true keeps the old, unauthenticated endpoints working while the
// updated app is being rolled out. Once the new app is live, remove it (or set
// it to false) so every endpoint requires a signed-in user.
const LEGACY = process.env.LEGACY_MODE === "true";
const APP_URL = process.env.APP_URL || "https://app.reviewsend.io";

// Where Google may send people back to after they connect their profile.
const GOOGLE_REDIRECT_URIS = [APP_URL, ...(process.env.EXTRA_GOOGLE_REDIRECT_URIS || "").split(",")]
  .map(s => s.trim()).filter(Boolean);

// Only these websites may call this server from a browser.
const ALLOWED_ORIGINS = [
  APP_URL,
  "http://localhost:5173",
  ...(process.env.EXTRA_ALLOWED_ORIGINS || "").split(","),
].map(s => s.trim()).filter(Boolean);
// Vercel preview copies of the app (only this team's projects).
const VERCEL_PREVIEW = /^https:\/\/reviewsend-[a-z0-9-]+-bentonisaiah03-4989s-projects\.vercel\.app$/;

const app = express();
app.set("trust proxy", 1); // Railway sits behind a proxy; this makes req.ip the real visitor IP

app.use(cors({
  origin: (origin, cb) => {
    // No Origin header = not a browser (curl, server-to-server); those still need a valid login.
    if (!origin || ALLOWED_ORIGINS.includes(origin) || VERCEL_PREVIEW.test(origin)) return cb(null, true);
    cb(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "200kb" }));

// Requires a signed-in user, except for old-style requests while LEGACY_MODE is on.
function authOrLegacy(req, res, next) {
  if (req.headers.authorization) return requireUser(req, res, next);
  if (LEGACY) { req.legacy = true; return next(); }
  return res.status(401).json({ success: false, error: "Please sign in again." });
}
// Runs `mw` only for signed-in (non-legacy) requests.
const unlessLegacy = mw => (req, res, next) => (req.legacy ? next() : mw(req, res, next));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── RATE LIMITERS ─────────────────────────────────────────────────────────────
function limitHandler(label) {
  return (req, res) => {
    const minutesLeft = Math.max(1, Math.ceil((new Date(req.rateLimit.resetTime) - Date.now()) / 60000));
    console.warn(`[RATE LIMIT] ${label} — IP: ${req.ip}, user: ${req.user?.email || req.body?.email || "-"}`);
    res.status(429).json({
      success: false,
      error: "Too many requests",
      message: `Too many attempts. Please wait ${minutesLeft} minute${minutesLeft !== 1 ? "s" : ""} and try again.`,
      retryAfter: minutesLeft * 60,
    });
  };
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => `${req.ip}:${lower(req.body?.email)}`,
  handler: limitHandler("Login"),
});

// Bulk send is capped at 50 per batch in the app; this allows a few batches an hour per person.
const textLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => req.user?.email || req.ip,
  handler: limitHandler("Texting"),
});

const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => req.user?.email || req.ip,
  handler: limitHandler("AI captions"),
});

// ── LOGIN RATE CHECK ──────────────────────────────────────────────────────────
// Called by the app just before it signs someone in, so repeated wrong
// passwords get slowed down. Every login (owners, staff, clients, employees)
// now goes through Supabase's own sign-in.
app.post("/business-login-check", loginLimiter, (req, res) => res.json({ allowed: true }));

// Old employee login (passwords compared in plain text). Only kept while the
// updated app rolls out; employees now sign in through Supabase like everyone else.
app.post("/employee-login", loginLimiter, wrap(async (req, res) => {
  if (!LEGACY) return res.status(410).json({ success: false, error: "Please refresh the page and sign in again." });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ success: false, error: "Missing email or password" });
  const employees = await sbAdmin(`/rest/v1/employees?email=eq.${encodeURIComponent(lower(email))}&select=*,businesses(*)`);
  const emp = employees?.[0];
  if (!emp || !emp.password || emp.password !== password) {
    return res.status(401).json({ success: false, error: "Invalid login credentials." });
  }
  const { password: _pw, ...safeEmp } = emp;
  console.log(`[LOGIN] Employee (legacy): ${email}`);
  res.json({ success: true, employee: safeEmp, business: emp.businesses });
}));

// ── TEXT MESSAGES ─────────────────────────────────────────────────────────────
const twilioClient = twilio(process.env.ACCOUNT_SID, process.env.AUTH_TOKEN);
const messagingServiceSid = process.env.MESSAGING_SERVICE_SID;
const US_PHONE = /^\+1\d{10}$/;

async function sendText(req, res, withMedia) {
  const { to, message } = req.body || {};
  if (!US_PHONE.test(String(to || ""))) return res.json({ success: false, error: "Please enter a valid 10-digit US phone number." });
  if (!message || String(message).length > 1000) return res.json({ success: false, error: "The message is empty or too long." });

  let mediaUrl = null;
  if (withMedia) {
    // Signed-in requests always use the business's own saved logo, never a link sent by the browser.
    mediaUrl = req.legacy ? req.body.mediaUrl : req.business?.logo_url;
  }
  try {
    const result = await twilioClient.messages.create({
      body: message, messagingServiceSid, to,
      ...(mediaUrl ? { mediaUrl: [mediaUrl] } : {}),
    });
    if (!req.legacy) console.log(`[SMS] ${req.user.email} → business ${req.business.id}`);
    res.json({ success: true, sid: result.sid });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
}

app.post("/send-sms", authOrLegacy, unlessLegacy(requireBusiness("member")), textLimiter, wrap((req, res) => sendText(req, res, false)));
app.post("/send-mms", authOrLegacy, unlessLegacy(requireBusiness("member")), textLimiter, wrap((req, res) => sendText(req, res, true)));

// ── LOGIN ACCOUNTS ────────────────────────────────────────────────────────────
const randomPassword = () => "TempPass_" + require("crypto").randomBytes(12).toString("base64url") + "!1";

async function findAuthUserByEmail(email) {
  // The admin list endpoint pages through users; filter on our side to be exact.
  for (let page = 1; page <= 50; page++) {
    const data = await sbAdmin(`/auth/v1/admin/users?page=${page}&per_page=200`);
    const users = data?.users || [];
    const hit = users.find(u => lower(u.email) === lower(email));
    if (hit) return hit;
    if (users.length < 200) return null;
  }
  return null;
}

async function createAuthUser(email, password) {
  try {
    const user = await sbAdmin(`/auth/v1/admin/users`, {
      method: "POST",
      body: { email: lower(email), password: password || randomPassword(), email_confirm: true },
    });
    return { user, existing: false };
  } catch (err) {
    const msg = String(err.message || "");
    if (err.status === 422 || /already (been )?registered|already exists/i.test(msg)) {
      return { user: await findAuthUserByEmail(email), existing: true };
    }
    throw err;
  }
}

// Is this email someone we must never delete through the app (an owner or staff login)?
async function isProtectedLogin(email) {
  const a = await getAccess(email);
  return isStaff(a);
}

// Staff create a login for a new client (they then get a "set your password" email).
app.post("/create-user", authOrLegacy, unlessLegacy(requireStaff), wrap(async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.json({ success: false, error: "Missing email" });
  const { user, existing } = await createAuthUser(email, null);
  res.json({ success: true, existing, user: user ? { id: user.id, email: user.email } : null });
}));

// Staff remove a client's login after deleting the client.
app.post("/delete-user", authOrLegacy, unlessLegacy(requireStaff), wrap(async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.json({ success: false, error: "Missing email" });
  if (!req.legacy) {
    if (lower(email) === req.user.email) return res.json({ success: false, error: "You can't delete your own login." });
    if (await isProtectedLogin(email)) return res.json({ success: false, error: "That login belongs to ReviewSend staff and can't be deleted here." });
  }
  const user = await findAuthUserByEmail(email);
  if (!user) return res.json({ success: true, message: "User not found in auth — nothing to delete" });
  await sbAdmin(`/auth/v1/admin/users/${user.id}`, { method: "DELETE" });
  console.log("Auth user deleted:", email, req.user ? `by ${req.user.email}` : "(legacy)");
  res.json({ success: true });
}));

// ── CLIENT EMPLOYEES ──────────────────────────────────────────────────────────
// Employees get a real login. Their password is handed to Supabase (which stores
// it securely) and is never saved in our own tables.
app.post("/employees/create", requireUser, requireBusiness("manage"), wrap(async (req, res) => {
  const { name, email, password } = req.body || {};
  const cleanEmail = lower(email);
  if (!name || !cleanEmail || !password) return res.json({ success: false, error: "Please fill in all fields." });
  if (String(password).length < 6) return res.json({ success: false, error: "Password must be at least 6 characters." });

  const already = await sbAdmin(`/rest/v1/employees?email=eq.${encodeURIComponent(cleanEmail)}&select=id`);
  if (already?.length) return res.json({ success: false, error: "An employee with that email already exists." });

  const { user, existing } = await createAuthUser(cleanEmail, password);
  if (existing) {
    return res.json({ success: false, error: "That email already has a ReviewSend login. Please use a different email for this employee." });
  }
  const rows = await sbAdmin(`/rest/v1/employees`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: [{ business_id: req.business.id, name: String(name).trim(), email: cleanEmail, auth_user_id: user.id }],
  });
  const emp = rows?.[0];
  console.log(`[EMPLOYEE] ${req.user.email} added ${cleanEmail} to business ${req.business.id}`);
  res.json({ success: true, employee: emp && { id: emp.id, name: emp.name, email: emp.email, business_id: emp.business_id, created_at: emp.created_at } });
}));

app.post("/employees/delete", requireUser, requireBusiness("manage"), wrap(async (req, res) => {
  const { employee_id } = req.body || {};
  const rows = await sbAdmin(`/rest/v1/employees?id=eq.${encodeURIComponent(employee_id)}&business_id=eq.${req.business.id}&select=id,email`);
  const emp = rows?.[0];
  if (!emp) return res.json({ success: false, error: "Employee not found." });
  await sbAdmin(`/rest/v1/employees?id=eq.${emp.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  // Remove their login too, unless the same email is also used for something else.
  const access = await getAccess(emp.email);
  const stillUsed = isStaff(access) || access.ownedBusinessIds.length || access.employeeBusinessIds.length;
  if (!stillUsed) {
    const user = await findAuthUserByEmail(emp.email);
    if (user) await sbAdmin(`/auth/v1/admin/users/${user.id}`, { method: "DELETE" });
  }
  console.log(`[EMPLOYEE] ${req.user.email} removed ${emp.email} from business ${req.business.id}`);
  res.json({ success: true });
}));

// ── GOOGLE BUSINESS PROFILE ───────────────────────────────────────────────────
// Signed-in requests send a business_id; the server looks up that business's
// Google keys itself. Legacy requests (old app) still send an access_token.

async function tokenFor(req) {
  if (req.legacy) return req.body.access_token;
  return tokens.getValidAccessToken(req.business.id);
}

function googleError(res, err) {
  return res.json({ success: false, error: err.message, needs_reconnect: !!err.needsReconnect });
}

// New: finish connecting Google for a business (code from Google's consent screen).
app.post("/google/connect", requireUser, requireBusiness("manage"), wrap(async (req, res) => {
  const { code, redirect_uri } = req.body || {};
  if (!code) return res.json({ success: false, error: "Missing code from Google." });
  const redirectUri = redirect_uri || APP_URL;
  if (!GOOGLE_REDIRECT_URIS.includes(redirectUri)) return res.json({ success: false, error: "That return address isn't allowed." });
  const data = await tokens.exchangeCode(code, redirectUri);
  if (data.error) return res.json({ success: false, error: data.error_description || data.error });
  await tokens.saveTokens(req.business.id, data);
  await sbAdmin(`/rest/v1/businesses?id=eq.${req.business.id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: { google_connected: true },
  });
  const locations = await google.listLocations(data.access_token);
  res.json({ ...locations, connected: true });
}));

// New: save which Google location this business is linked to.
app.post("/google/select-location", requireUser, requireBusiness("manage"), wrap(async (req, res) => {
  const { account_id, location_id } = req.body || {};
  if (!account_id || !location_id) return res.json({ success: false, error: "Missing location." });
  await sbAdmin(`/rest/v1/businesses?id=eq.${req.business.id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: { google_account_id: account_id, google_location_id: location_id, google_connected: true },
  });
  res.json({ success: true });
}));

// New: disconnect Google and delete the stored keys.
app.post("/google/disconnect", requireUser, requireBusiness("manage"), wrap(async (req, res) => {
  await tokens.deleteTokens(req.business.id);
  await sbAdmin(`/rest/v1/businesses?id=eq.${req.business.id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: { google_connected: false, google_account_id: null, google_location_id: null },
  });
  if (LEGACY) {
    try {
      await sbAdmin(`/rest/v1/businesses?id=eq.${req.business.id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: { google_access_token: null, google_refresh_token: null, google_token_expiry: null },
      });
    } catch { /* old columns already removed */ }
  }
  res.json({ success: true });
}));

// Old: browser exchanges the code and receives the keys. Legacy only.
app.post("/google/token", wrap(async (req, res) => {
  if (!LEGACY) return res.status(410).json({ success: false, error: "Please refresh the page and try again." });
  const { code, redirectUri } = req.body || {};
  const data = await tokens.exchangeCode(code, redirectUri);
  if (data.error) return res.json({ success: false, error: data.error_description || data.error });
  res.json({ success: true, access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in });
}));

// Old: browser refreshes a key it holds. Legacy only.
app.post("/google/refresh-token", wrap(async (req, res) => {
  if (!LEGACY) return res.status(410).json({ success: false, error: "Please refresh the page and try again." });
  const { refresh_token } = req.body || {};
  if (!refresh_token) return res.json({ success: false, error: "No refresh token on file — a full reconnect is needed." });
  const data = await tokens.googleTokenRequest({ refresh_token, grant_type: "refresh_token" });
  if (data.error) return res.json({ success: false, error: data.error_description || data.error, needs_reconnect: data.error === "invalid_grant" });
  res.json({ success: true, access_token: data.access_token, expires_in: data.expires_in });
}));

app.post("/google/locations", authOrLegacy, unlessLegacy(requireBusiness("manage")), wrap(async (req, res) => {
  try { res.json(await google.listLocations(await tokenFor(req))); } catch (err) { googleError(res, err); }
}));

app.post("/google/data", authOrLegacy, unlessLegacy(requireBusiness("member")), wrap(async (req, res) => {
  try {
    const accessToken = await tokenFor(req);
    const accountId = req.body.account_id || req.business?.google_account_id;
    const locationId = req.body.location_id || req.business?.google_location_id;
    const businessId = req.legacy ? req.body.business_id : req.business.id;
    res.json(await google.fetchLocationData(accessToken, accountId, locationId, businessId));
  } catch (err) { googleError(res, err); }
}));

app.post("/google/performance", authOrLegacy, unlessLegacy(requireBusiness("member")), wrap(async (req, res) => {
  try {
    const locationId = req.body.location_id || req.business?.google_location_id;
    res.json(await google.fetchPerformance(await tokenFor(req), locationId));
  } catch (err) { googleError(res, err); }
}));

app.post("/google/searchkeywords", authOrLegacy, unlessLegacy(requireBusiness("member")), wrap(async (req, res) => {
  try {
    const locationId = req.body.location_id || req.business?.google_location_id;
    res.json(await google.fetchSearchKeywords(await tokenFor(req), locationId));
  } catch (err) { googleError(res, err); }
}));

// ── AI CAPTIONS ───────────────────────────────────────────────────────────────
// The AI key now lives only on this server (ANTHROPIC_API_KEY), never in the browser.
app.post("/ai/caption", requireUser, requireBusiness("member"), aiLimiter, wrap(async (req, res) => {
  const { prompt } = req.body || {};
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.json({ success: false, error: "AI captions aren't set up on the server yet." });
  if (!prompt || String(prompt).length > 6000) return res.json({ success: false, error: "Missing or too-long prompt." });
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5", max_tokens: 500, messages: [{ role: "user", content: String(prompt) }] }),
  });
  const data = await response.json();
  if (!response.ok) return res.json({ success: false, error: `AI error ${response.status}: ${data.error?.message || "Unknown error"}` });
  res.json({ success: true, text: data.content?.[0]?.text || "" });
}));

// ── PASSWORDS ─────────────────────────────────────────────────────────────────
// All password emails go through Resend (our own email service), with a real
// one-time link from Supabase. Supabase's built-in email only reliably reaches
// our own team, so clients never got those.

async function recoveryLink(email) {
  // Supabase's admin endpoint is /admin/generate_link (the old code called a
  // non-existent address, so every email went out with a link to the homepage).
  const data = await sbAdmin(`/auth/v1/admin/generate_link`, {
    method: "POST",
    body: { type: "recovery", email: lower(email), redirect_to: APP_URL },
  });
  const link = data?.action_link || data?.properties?.action_link;
  if (!link) throw new Error("Supabase did not return a reset link.");
  return link;
}

async function sendPasswordEmail(email, businessName) {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) throw new Error("Resend API key not configured");
  const link = await recoveryLink(email);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendApiKey}` },
    body: JSON.stringify({
      from: "ReviewSend <noreply@reviewsend.io>",
      to: [lower(email)],
      subject: "Set or Reset Your ReviewSend Password",
      html: inviteEmailHtml(businessName || "your business", link),
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Resend error");
  return data.id;
}

// Staff send a client the "set your password" email (also used for new clients).
// Creates the client's login first if it doesn't exist yet.
app.post("/send-invite", authOrLegacy, unlessLegacy(requireStaff), wrap(async (req, res) => {
  const { email, businessName } = req.body || {};
  if (!email) return res.json({ success: false, error: "Missing email" });
  try {
    await createAuthUser(email, null); // no-op if the login already exists
    const id = await sendPasswordEmail(email, businessName);
    console.log(`[PASSWORD] Setup email sent to ${lower(email)} by ${req.user?.email || "(legacy)"}: ${id}`);
    res.json({ success: true, id });
  } catch (err) {
    console.error("Send invite error:", err.message);
    res.json({ success: false, error: err.message });
  }
}));

// "Forgot password?" on the sign-in screen. Always answers the same way, so it
// can't be used to find out which emails have accounts.
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => `${req.ip}:${lower(req.body?.email)}`,
  handler: limitHandler("Forgot password"),
});
app.post("/forgot-password", forgotLimiter, wrap(async (req, res) => {
  const email = lower(req.body?.email);
  if (email && (await findAuthUserByEmail(email))) {
    try {
      const biz = await sbAdmin(`/rest/v1/businesses?email=eq.${encodeURIComponent(email)}&select=name`);
      const id = await sendPasswordEmail(email, biz?.[0]?.name);
      console.log(`[PASSWORD] Forgot-password email sent to ${email}: ${id}`);
    } catch (err) {
      console.error("Forgot password error:", err.message);
    }
  }
  res.json({ success: true });
}));

// Staff set a new password for a client (or one of the client's employees)
// directly, then tell them. Only staff who manage that client can do this.
app.post("/set-password", requireUser, requireBusiness("staff"), wrap(async (req, res) => {
  const { password, employee_id } = req.body || {};
  if (!password || String(password).length < 8) return res.json({ success: false, error: "Password must be at least 8 characters." });
  let email = req.business.email;
  if (employee_id) {
    const rows = await sbAdmin(`/rest/v1/employees?id=eq.${encodeURIComponent(employee_id)}&business_id=eq.${req.business.id}&select=email`);
    if (!rows?.[0]) return res.json({ success: false, error: "Employee not found." });
    email = rows[0].email;
  }
  if (!email) return res.json({ success: false, error: "This client has no login email on file." });
  if (await isProtectedLogin(email)) return res.json({ success: false, error: "That login belongs to ReviewSend staff." });
  let user = await findAuthUserByEmail(email);
  if (!user) user = (await createAuthUser(email, password)).user;
  else await sbAdmin(`/auth/v1/admin/users/${user.id}`, { method: "PUT", body: { password: String(password) } });
  console.log(`[PASSWORD] ${req.user.email} set a new password for ${lower(email)} (business ${req.business.id})`);
  res.json({ success: true, email: lower(email) });
}));

// ── ERROR HANDLER ────────────────────────────────────────────────────────────
app.get("/", (req, res) => { res.send("ReviewSend server is running!"); });

app.use((err, req, res, next) => {
  Sentry.captureException(err);
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, error: "Something went wrong on our end. Please try again." });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => { console.log(`Server is running on port ${PORT}${LEGACY ? " (LEGACY_MODE on)" : ""}`); });
}

module.exports = app;
