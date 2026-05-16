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
const twilioPhone = process.env.TWILIO_PHONE;
const resendApiKey = process.env.RESEND_API_KEY;
const client = twilio(accountSid, authToken);

app.post("/send-sms", async (req, res) => {
  const { to, message } = req.body;
  try {
    const result = await client.messages.create({ body: message, from: twilioPhone, to });
    res.json({ success: true, sid: result.sid });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post("/send-mms", async (req, res) => {
  const { to, message, mediaUrl } = req.body;
  try {
    const result = await client.messages.create({ body: message, from: twilioPhone, to, mediaUrl: [mediaUrl] });
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

app.post("/google/data", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { access_token } = req.body;
  if (!access_token) return res.json({ success: false, error: "No access token" });
  try {
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
    const account = accountsData.accounts[0];

    // 2. Get location info
    const locationsRes = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title,storefrontAddress,websiteUri,regularHours,primaryPhone`,
      { headers: { "Authorization": `Bearer ${access_token}` } }
    );
    const locationsData = await locationsRes.json();
    if (!locationsData.locations || locationsData.locations.length === 0) {
      return res.json({ success: false, error: "No locations found for this account." });
    }
    const location = locationsData.locations[0];
    const locationName = location.name; // e.g. "accounts/123/locations/456"

    // 3. Fetch reviews (includes averageRating + totalReviewCount)
    let rating = null;
    let reviewCount = null;
    let reviews = [];

    try {
      const reviewsRes = await fetch(
        `https://mybusiness.googleapis.com/v4/${locationName}/reviews?pageSize=5&orderBy=updateTime%20desc`,
        { headers: { "Authorization": `Bearer ${access_token}` } }
      );
      const reviewsData = await reviewsRes.json();

      if (reviewsData.averageRating) rating = reviewsData.averageRating;
      if (reviewsData.totalReviewCount) reviewCount = reviewsData.totalReviewCount;

      if (reviewsData.reviews && Array.isArray(reviewsData.reviews)) {
        const starMap = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
        reviews = reviewsData.reviews.map(r => {
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
          };
        });
      }
    } catch (reviewErr) {
      console.warn("Reviews fetch failed (non-fatal):", reviewErr.message);
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
