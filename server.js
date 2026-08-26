const Sentry = require("@sentry/node");
const express = require("express");
const twilio = require("twilio");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

// ── SENTRY ────────────────────────────────────────────────────────────────────
// Sentry v8: init must happen before anything else, no Handlers.requestHandler needed
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || "production",
  tracesSampleRate: 0.2,
});

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());

// ── RATE LIMITERS ─────────────────────────────────────────────────────────────
const businessOwnerLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip,
  handler: (req, res) => {
    const resetTime = new Date(req.rateLimit.resetTime);
    const minutesLeft = Math.ceil((resetTime - Date.now()) / 60000);
    console.warn(`[RATE LIMIT] Business owner login blocked — IP: ${req.ip}`);
    res.status(429).json({
      error: "Too many login attempts",
      message: `Too many failed attempts. Please wait ${minutesLeft} minute${minutesLeft !== 1 ? "s" : ""} before trying again.`,
      retryAfter: minutesLeft * 60,
    });
  },
});

const employeeLoginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    const identifier = req.body?.email || "unknown";
    return `${ip}:${identifier}`;
  },
  handler: (req, res) => {
    const resetTime = new Date(req.rateLimit.resetTime);
    const minutesLeft = Math.ceil((resetTime - Date.now()) / 60000);
    console.warn(`[RATE LIMIT] Employee login blocked — IP: ${req.ip}, email: ${req.body?.email}`);
    res.status(429).json({
      error: "Too many login attempts",
      message: `Too many failed attempts. Please wait ${minutesLeft} minute${minutesLeft !== 1 ? "s" : ""} before trying again.`,
      retryAfter: minutesLeft * 60,
    });
  },
});

// ── BUSINESS OWNER LOGIN CHECK ────────────────────────────────────────────────
app.options("/business-login-check", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

app.post("/business-login-check", businessOwnerLoginLimiter, (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ allowed: true });
});

// ── EMPLOYEE LOGIN ────────────────────────────────────────────────────────────
app.options("/employee-login", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

app.post("/employee-login", employeeLoginLimiter, async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Missing email or password" });
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ success: false, error: "Server configuration error" });
  }
  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/employees?email=eq.${encodeURIComponent(email.trim().toLowerCase())}&select=*,businesses(*)`,
      {
        headers: {
          "apikey": serviceKey,
          "Authorization": `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    const employees = await response.json();
    const emp = employees?.[0];
    if (!emp || emp.password !== password) {
      return res.status(401).json({ success: false, error: "Invalid login credentials." });
    }
    const { password: _pw, ...safeEmp } = emp;
    console.log(`[LOGIN] Employee: ${email}`);
    res.json({ success: true, employee: safeEmp, business: emp.businesses });
  } catch (err) {
    console.error("Employee login error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

const accountSid = process.env.ACCOUNT_SID;
const authToken = process.env.AUTH_TOKEN;
const messagingServiceSid = process.env.MESSAGING_SERVICE_SID;
const resendApiKey = process.env.RESEND_API_KEY;
const client = twilio(accountSid, authToken);

app.post("/send-sms", async (req, res) => {
  const { to, message } = req.body;
  try {
    const result = await client.messages.create({ body: message, messagingServiceSid, to });
    res.json({ success: true, sid: result.sid });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post("/send-mms", async (req, res) => {
  const { to, message, mediaUrl } = req.body;
  try {
    const result = await client.messages.create({ body: message, messagingServiceSid, to, mediaUrl: [mediaUrl] });
    res.json({ success: true, sid: result.sid });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.options("/create-user", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

app.post("/create-user", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { email, password } = req.body;
  if (!email) return res.json({ success: false, error: "Missing email" });
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return res.json({ success: false, error: "Supabase admin credentials not configured" });
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": serviceKey, "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({
        email,
        password: password || ("TempPass_" + Math.random().toString(36).slice(2, 10) + "!1"),
        email_confirm: true,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      if (data.msg && data.msg.includes("already been registered")) return res.json({ success: true, existing: true });
      return res.json({ success: false, error: data.msg || data.message || "Error creating user" });
    }
    res.json({ success: true, user: data });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.options("/delete-user", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

app.post("/delete-user", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { email } = req.body;
  if (!email) return res.json({ success: false, error: "Missing email" });
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return res.json({ success: false, error: "Supabase admin credentials not configured" });
  try {
    const listResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
      headers: { "apikey": serviceKey, "Authorization": `Bearer ${serviceKey}` },
    });
    const listData = await listResponse.json();
    const user = listData.users?.[0];
    if (!user) return res.json({ success: true, message: "User not found in auth — nothing to delete" });
    const deleteResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, {
      method: "DELETE",
      headers: { "apikey": serviceKey, "Authorization": `Bearer ${serviceKey}` },
    });
    if (!deleteResponse.ok) {
      const err = await deleteResponse.json();
      return res.json({ success: false, error: err.message || "Error deleting user" });
    }
    console.log("Auth user deleted:", email);
    res.json({ success: true });
  } catch (error) {
    console.error("Delete user error:", error);
    res.json({ success: false, error: error.message });
  }
});

app.options("/google/token", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

app.options("/google/data", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

app.options("/google/refresh-token", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

// Google access tokens expire after ~1 hour. Rather than making the user go
// through the full OAuth consent screen again, this uses the refresh_token we
// stored at connect time to silently get a new access_token.
app.post("/google/refresh-token", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { refresh_token } = req.body;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!refresh_token) return res.json({ success: false, error: "No refresh token on file — a full reconnect is needed." });
  if (!clientId || !clientSecret) return res.json({ success: false, error: "Google credentials not configured" });
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ refresh_token, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token" }),
    });
    const data = await response.json();
    if (data.error) {
      // A refresh_token can itself go bad (revoked access, password change, etc.)
      // — that genuinely does require a full reconnect, so we say so plainly.
      return res.json({ success: false, error: data.error_description || data.error, needs_reconnect: data.error === "invalid_grant" });
    }
    res.json({ success: true, access_token: data.access_token, expires_in: data.expires_in });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post("/google/token", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { code, redirectUri } = req.body;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.json({ success: false, error: "Google credentials not configured" });
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    });
    const data = await response.json();
    if (data.error) return res.json({ success: false, error: data.error_description || data.error });
    res.json({ success: true, access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.options("/google/locations", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

// Returns EVERY location across EVERY account this Google login can access —
// used to power a picker when someone manages multiple businesses/locations.
app.post("/google/locations", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { access_token } = req.body;
  if (!access_token) return res.json({ success: false, error: "No access token" });
  try {
    const accountsRes = await fetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", {
      headers: { "Authorization": `Bearer ${access_token}` },
    });
    const accountsData = await accountsRes.json();
    if (!accountsData.accounts || accountsData.accounts.length === 0) {
      return res.json({ success: false, error: "No Google Business accounts found on this login.", debug: accountsData });
    }

    const allLocations = [];
    const perAccountDebug = [];
    for (const acct of accountsData.accounts) {
      const locationsRes = await fetch(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${acct.name}/locations?readMask=name,title,storefrontAddress,websiteUri,phoneNumbers`,
        { headers: { "Authorization": `Bearer ${access_token}` } }
      );
      const locationsData = await locationsRes.json();
      console.log(`[GOOGLE] Locations for ${acct.name} (${acct.type || "unknown"}): status=${locationsRes.status}`, JSON.stringify(locationsData));

      perAccountDebug.push({
        account: acct.name,
        type: acct.type || "unknown",
        http_status: locationsRes.status,
        // Surface Google's actual error reason if this call failed, instead of
        // silently treating "no locations field" the same as "genuinely empty".
        google_error: locationsData.error ? (locationsData.error.message || locationsData.error) : null,
        location_count: locationsData.locations?.length || 0,
      });

      if (locationsData.locations && locationsData.locations.length > 0) {
        for (const loc of locationsData.locations) {
          allLocations.push({
            account_id: acct.name,
            account_type: acct.type || null,
            location_id: loc.name, // e.g. "accounts/123/locations/456"
            title: loc.title,
            address: loc.storefrontAddress
              ? [loc.storefrontAddress.addressLines?.join(", "), loc.storefrontAddress.locality, loc.storefrontAddress.administrativeArea].filter(Boolean).join(", ")
              : null,
            website: loc.websiteUri || null,
          });
        }
      }
    }

    if (allLocations.length === 0) {
      return res.json({
        success: false,
        error: "No locations found on any account for this Google login.",
        debug: perAccountDebug,
      });
    }

    res.json({ success: true, locations: allLocations });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.options("/google/performance", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

// Search views (Maps + Search combined), calls, direction requests, and website
// clicks — pulled from the Business Profile Performance API. Returns last-30-day
// totals with a delta vs the prior 30 days, plus a 6-month monthly trend for
// profile views (used for the views chart, since Google doesn't expose a
// pre-aggregated monthly view).
app.post("/google/performance", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { access_token, location_id } = req.body;
  if (!access_token || !location_id) return res.json({ success: false, error: "Missing access_token or location_id" });
  try {
    const metrics = [
      "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
      "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
      "CALL_CLICKS", "BUSINESS_DIRECTION_REQUESTS", "WEBSITE_CLICKS",
    ];
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 180); // 6 months back covers both the monthly trend and 30/60-day deltas

    const params = new URLSearchParams();
    metrics.forEach(m => params.append("dailyMetrics", m));
    params.append("dailyRange.start_date.year", start.getFullYear());
    params.append("dailyRange.start_date.month", start.getMonth() + 1);
    params.append("dailyRange.start_date.day", start.getDate());
    params.append("dailyRange.end_date.year", end.getFullYear());
    params.append("dailyRange.end_date.month", end.getMonth() + 1);
    params.append("dailyRange.end_date.day", end.getDate());

    const perfRes = await fetch(
      `https://businessprofileperformance.googleapis.com/v1/${location_id}:fetchMultiDailyMetricsTimeSeries?${params}`,
      { headers: { "Authorization": `Bearer ${access_token}` } }
    );
    const perfData = await perfRes.json();
    console.log(`[GOOGLE] Performance API status=${perfRes.status}`, JSON.stringify(perfData).slice(0, 800));

    if (!perfRes.ok) {
      return res.json({ success: false, error: perfData.error?.message || "Performance API request failed.", http_status: perfRes.status });
    }

    // Flatten Google's nested response into { METRIC_NAME: [{date, value}] }
    const series = {};
    for (const group of (perfData.multiDailyMetricTimeSeries || [])) {
      for (const dm of (group.dailyMetricTimeSeries || [])) {
        const points = (dm.timeSeries?.datedValues || []).map(dv => ({
          date: `${dv.date.year}-${String(dv.date.month).padStart(2, "0")}-${String(dv.date.day).padStart(2, "0")}`,
          value: Number(dv.value || 0),
        }));
        series[dm.dailyMetric] = points;
      }
    }

    const combine = (...arrs) => {
      const byDate = {};
      arrs.forEach(arr => (arr || []).forEach(p => { byDate[p.date] = (byDate[p.date] || 0) + p.value; }));
      return Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
    };
    const sum = (arr) => arr.reduce((a, b) => a + b.value, 0);

    const viewsSeries = combine(series.BUSINESS_IMPRESSIONS_DESKTOP_MAPS, series.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH, series.BUSINESS_IMPRESSIONS_MOBILE_MAPS, series.BUSINESS_IMPRESSIONS_MOBILE_SEARCH);
    const callsSeries = series.CALL_CLICKS || [];
    const directionsSeries = series.BUSINESS_DIRECTION_REQUESTS || [];
    const websiteSeries = series.WEBSITE_CLICKS || [];

    const totalsFor = (arr) => {
      const last30 = sum(arr.slice(-30));
      const prior30 = sum(arr.slice(-60, -30));
      const delta = prior30 > 0 ? Math.round(((last30 - prior30) / prior30) * 1000) / 10 : null;
      return { total: last30, delta };
    };

    // Monthly aggregation for the profile-views trend chart
    const monthlyViews = {};
    viewsSeries.forEach(p => {
      const monthKey = p.date.slice(0, 7);
      monthlyViews[monthKey] = (monthlyViews[monthKey] || 0) + p.value;
    });
    const monthlyViewsTrend = Object.entries(monthlyViews)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)
      .map(([month, value]) => ({ month, value }));

    res.json({
      success: true,
      search_views: totalsFor(viewsSeries),
      calls: totalsFor(callsSeries),
      direction_requests: totalsFor(directionsSeries),
      website_clicks: totalsFor(websiteSeries),
      monthly_views_trend: monthlyViewsTrend,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.options("/google/searchkeywords", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

// Actual search terms that surfaced this business in Google Search/Maps, with
// impression counts. Low-volume terms come back from Google as a threshold
// range (e.g. "1-100") rather than an exact number — that's a Google privacy
// behavior, not something we can resolve to an exact figure.
app.post("/google/searchkeywords", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { access_token, location_id } = req.body;
  if (!access_token || !location_id) return res.json({ success: false, error: "Missing access_token or location_id" });
  try {
    const end = new Date();
    const start = new Date();
    start.setMonth(start.getMonth() - 3);

    const params = new URLSearchParams({
      "monthlyRange.start_month.year": start.getFullYear(),
      "monthlyRange.start_month.month": start.getMonth() + 1,
      "monthlyRange.end_month.year": end.getFullYear(),
      "monthlyRange.end_month.month": end.getMonth() + 1,
    });

    const kwRes = await fetch(
      `https://businessprofileperformance.googleapis.com/v1/${location_id}/searchkeywords/impressions/monthly?${params}`,
      { headers: { "Authorization": `Bearer ${access_token}` } }
    );
    const kwData = await kwRes.json();
    console.log(`[GOOGLE] Search keywords status=${kwRes.status}`, JSON.stringify(kwData).slice(0, 800));

    if (!kwRes.ok) {
      return res.json({ success: false, error: kwData.error?.message || "Search keywords request failed.", http_status: kwRes.status });
    }

    // Sum each term's impressions across the months returned; keep the
    // threshold label if Google never gave an exact number for that term.
    const totals = {};
    for (const monthly of (kwData.searchKeywordsCounts || [])) {
      const term = monthly.searchKeyword;
      const iv = monthly.insightsValue || {};
      if (!totals[term]) totals[term] = { numeric: 0, thresholdLabel: null };
      if (iv.value != null) totals[term].numeric += Number(iv.value);
      else if (iv.threshold != null) totals[term].thresholdLabel = iv.threshold;
    }

    const keywords = Object.entries(totals)
      .map(([term, t]) => ({ term, impressions: t.numeric > 0 ? t.numeric : (t.thresholdLabel || "< 100") }))
      .sort((a, b) => (typeof b.impressions === "number" ? b.impressions : 0) - (typeof a.impressions === "number" ? a.impressions : 0))
      .slice(0, 15);

    res.json({ success: true, keywords });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post("/google/data", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { access_token, account_id, location_id } = req.body;
  if (!access_token) return res.json({ success: false, error: "No access token" });
  try {
    let account, location, locationName;

    // If a specific location was chosen (from the picker), fetch it directly —
    // no need to re-scan every account.
    if (account_id && location_id) {
      const locationRes = await fetch(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${location_id}?readMask=name,title,storefrontAddress,websiteUri,regularHours,phoneNumbers`,
        { headers: { "Authorization": `Bearer ${access_token}` } }
      );
      location = await locationRes.json();
      if (!location || !location.name) {
        return res.json({ success: false, error: "Could not fetch the selected location." });
      }
      account = { name: account_id };
      locationName = location.name;
    } else {
      // Fallback: no specific location chosen — auto-pick like before
      // (kept for backward compatibility / single-location businesses).
      // 1. Get accounts
      const accountsRes = await fetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", {
        headers: { "Authorization": `Bearer ${access_token}` },
      });
      const accountsData = await accountsRes.json();
      console.log("[GOOGLE] Accounts API response:", JSON.stringify(accountsData));
      if (!accountsData.accounts || accountsData.accounts.length === 0) {
        console.log("[GOOGLE] No accounts found. Full response:", JSON.stringify(accountsData));
        return res.json({ success: false, error: "No Google Business accounts found. Make sure this Google account owns a Business Profile.", debug: accountsData });
      }
      // 2. FIX: try every account returned, not just accounts[0] — a Google login
      // can return multiple account resources (PERSONAL / ORGANIZATION / LOCATION_GROUP)
      // and only one of them may actually have locations attached.
      let locationsData = null;

      for (const candidate of accountsData.accounts) {
        const locationsRes = await fetch(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${candidate.name}/locations?readMask=name,title,storefrontAddress,websiteUri,regularHours,phoneNumbers`,
          { headers: { "Authorization": `Bearer ${access_token}` } }
        );
        const candidateLocations = await locationsRes.json();
        console.log(`[GOOGLE] Locations for ${candidate.name} (${candidate.type || "unknown type"}):`, JSON.stringify(candidateLocations));

        if (candidateLocations.locations && candidateLocations.locations.length > 0) {
          account = candidate;
          locationsData = candidateLocations;
          break; // found an account with real locations — stop here
        }
      }

      if (!account || !locationsData) {
        return res.json({
          success: false,
          error: "No locations found on any of your Google accounts.",
          debug: accountsData.accounts.map(a => ({ name: a.name, type: a.type })),
        });
      }

      location = locationsData.locations[0];
      locationName = location.name;
    }

    // NOTE: this is now either the specific location the user picked, or —
    // if no location_id was passed — the first one auto-found (old behavior,
    // kept for backward compatibility).

    // 3. Fetch reviews. We pull more than the 5 we display so we can compute a
    // real sentiment breakdown (Google doesn't give you a star-count breakdown
    // directly — you have to fetch reviews and tally them yourself). Capped at
    // 150 reviews / 3 pages to keep this fast; sentiment is "based on your most
    // recent reviews" rather than literally every review ever for high-volume businesses.
    let rating = null;
    let reviewCount = null;
    let allFetchedReviews = [];
    let pageToken = null;
    let pagesFetched = 0;

    try {
      do {
        const url = `https://mybusiness.googleapis.com/v4/${locationName}/reviews?pageSize=50&orderBy=updateTime%20desc${pageToken ? `&pageToken=${pageToken}` : ""}`;
        const reviewsRes = await fetch(url, { headers: { "Authorization": `Bearer ${access_token}` } });
        const reviewsData = await reviewsRes.json();

        if (pagesFetched === 0) {
          if (reviewsData.averageRating) rating = reviewsData.averageRating;
          if (reviewsData.totalReviewCount) reviewCount = reviewsData.totalReviewCount;
        }
        if (reviewsData.reviews && Array.isArray(reviewsData.reviews)) {
          allFetchedReviews.push(...reviewsData.reviews);
        }
        pageToken = reviewsData.nextPageToken || null;
        pagesFetched++;
      } while (pageToken && pagesFetched < 3);
    } catch (reviewErr) {
      console.warn("Reviews fetch failed (non-fatal):", reviewErr.message);
    }

    const starMap = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
    const mapReview = (r) => {
      const updated = new Date(r.updateTime);
      const diffDays = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
      let time_ago = "recently";
      if (diffDays === 0) time_ago = "today";
      else if (diffDays === 1) time_ago = "1d ago";
      else if (diffDays < 7) time_ago = `${diffDays}d ago`;
      else if (diffDays < 30) time_ago = `${Math.floor(diffDays / 7)}w ago`;
      else if (diffDays < 365) time_ago = `${Math.floor(diffDays / 30)}mo ago`;
      else time_ago = `${Math.floor(diffDays / 365)}y ago`;
      return {
        reviewer_name: r.reviewer?.displayName || "Anonymous",
        star_rating: starMap[r.starRating] || 5,
        comment: r.comment || "",
        time_ago,
        replied: !!r.reviewReply,
      };
    };

    const reviews = allFetchedReviews.slice(0, 5).map(mapReview); // for the "recent reviews" list
    const sentiment = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    let repliedCount = 0;
    allFetchedReviews.forEach(r => {
      const stars = starMap[r.starRating] || 5;
      sentiment[stars] = (sentiment[stars] || 0) + 1;
      if (r.reviewReply) repliedCount++;
    });
    const responseRate = allFetchedReviews.length > 0 ? Math.round((repliedCount / allFetchedReviews.length) * 100) : null;
    const now = new Date();
    const newThisMonth = allFetchedReviews.filter(r => {
      const d = new Date(r.updateTime);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;

    // 4. Save today's rating/review-count snapshot to Supabase so we can chart
    // rating history over time later — Google's API only ever gives you the
    // CURRENT rating, never a historical time series, so this is the only way
    // to build that trend. Requires a `rating_snapshots` table (see project docs).
    const { business_id } = req.body;
    if (business_id && rating != null) {
      const supabaseUrl = process.env.SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_KEY;
      if (supabaseUrl && serviceKey) {
        try {
          const today = new Date().toISOString().slice(0, 10);
          await fetch(`${supabaseUrl}/rest/v1/rating_snapshots?on_conflict=business_id,snapshot_date`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "apikey": serviceKey,
              "Authorization": `Bearer ${serviceKey}`,
              "Prefer": "resolution=merge-duplicates",
            },
            body: JSON.stringify([{ business_id, snapshot_date: today, rating, review_count: reviewCount }]),
          });
        } catch (snapErr) {
          console.warn("Rating snapshot save failed (non-fatal):", snapErr.message);
        }
      }
    }

    res.json({
      success: true,
      account_id: account.name,
      location_id: locationName,
      location_name: location.title,
      address: location.storefrontAddress,
      rating,
      review_count: reviewCount,
      reviews,
      sentiment,
      sentiment_based_on: allFetchedReviews.length,
      response_rate: responseRate,
      new_this_month: newThisMonth,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.options("/send-invite", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

// ── SEND INVITE EMAIL ─────────────────────────────────────────────────────────
app.post("/send-invite", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { email, businessName } = req.body;
  if (!email || !businessName) return res.json({ success: false, error: "Missing email or businessName" });
  if (!resendApiKey) return res.json({ success: false, error: "Resend API key not configured" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  try {
    // Step 1: Generate a real one-time recovery link via Supabase Admin API
    let setupLink = "https://app.reviewsend.io";
    if (supabaseUrl && serviceKey) {
      try {
        const linkRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/generate-link`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": serviceKey,
            "Authorization": `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            type: "recovery",
            email: email,
            options: { redirect_to: "https://app.reviewsend.io" },
          }),
        });
        const linkData = await linkRes.json();
        if (linkData.action_link) {
          setupLink = linkData.action_link;
          console.log("Setup link generated for:", email);
        } else if (linkData.properties?.action_link) {
          setupLink = linkData.properties.action_link;
          console.log("Setup link generated (properties) for:", email);
        } else {
          console.warn("generate-link response:", JSON.stringify(linkData));
          if (anonKey) {
            await fetch(`${supabaseUrl}/auth/v1/recover`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "apikey": anonKey,
              },
              body: JSON.stringify({
                email: email,
                options: { redirect_to: "https://app.reviewsend.io" },
              }),
            });
            console.log("Fallback: triggered Supabase recovery email for:", email);
          }
        }
      } catch (linkErr) {
        console.warn("Link generation error:", linkErr.message);
      }
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${resendApiKey}` },
      body: JSON.stringify({
        from: "ReviewSend <noreply@reviewsend.io>",
        to: [email],
        subject: "Welcome to ReviewSend — Set Up Your Account",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 20px; background: #F4F7FB;">
            <div style="background: #fff; border-radius: 16px; padding: 40px; border: 1px solid #D6E2F0;">
              <div style="text-align: center; margin-bottom: 32px;">
                <div style="font-size: 13px; font-weight: 600; letter-spacing: 5px; color: #1A5FBF; text-transform: uppercase;">★ ReviewSend</div>
              </div>
              <h1 style="font-size: 26px; font-weight: 700; color: #0D1117; margin: 0 0 12px;">Welcome to ReviewSend!</h1>
              <p style="font-size: 15px; color: rgba(13,17,23,0.6); line-height: 1.7; margin: 0 0 16px;">
                Your ReviewSend account for <strong>${businessName}</strong> has been created.
              </p>
              <p style="font-size: 15px; color: rgba(13,17,23,0.6); line-height: 1.7; margin: 0 0 32px;">
                Click the button below to set your password and access your dashboard. This link expires in <strong>24 hours</strong>.
              </p>
              <div style="text-align: center; margin-bottom: 28px;">
                <a href="${setupLink}" style="display: inline-block; background: #1A5FBF; color: #fff; padding: 14px 36px; border-radius: 8px; font-size: 15px; font-weight: 600; text-decoration: none;">
                  Set Up My Account →
                </a>
              </div>
              <div style="background: #F4F7FB; border-radius: 10px; padding: 14px 18px; margin-bottom: 24px;">
                <p style="font-size: 12px; font-weight: 600; color: rgba(13,17,23,0.5); margin: 0 0 6px;">Button not working? Copy and paste this link into your browser:</p>
                <p style="font-size: 11px; color: rgba(13,17,23,0.4); margin: 0; word-break: break-all;">${setupLink}</p>
              </div>
              <p style="font-size: 13px; color: rgba(13,17,23,0.4); text-align: center; margin: 0;">
                Questions? Email us at support.reviewsend@gmail.com
              </p>
            </div>
          </div>
        `,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("Resend error:", data);
      return res.json({ success: false, error: data.message || "Resend error" });
    }
    console.log("Invite email sent:", data.id);
    res.json({ success: true, id: data.id });
  } catch (error) {
    console.error("Send invite error:", error);
    res.json({ success: false, error: error.message });
  }
});

// ── ERROR HANDLER ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  Sentry.captureException(err);
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, error: "Internal server error" });
});

app.get("/", (req, res) => { res.send("ReviewSend server is running!"); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log("Server is running on port " + PORT); });
