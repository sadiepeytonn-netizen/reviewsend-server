const express = require("express");
const twilio = require("twilio");
const cors = require("cors");
const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());

const accountSid = process.env.ACCOUNT_SID;
const authToken = process.env.AUTH_TOKEN;
const twilioPhone = process.env.TWILIO_PHONE;
const resendApiKey = process.env.RESEND_API_KEY;
const client = twilio(accountSid, authToken);

// SMS (no logo)
app.post("/send-sms", async (req, res) => {
  const { to, message } = req.body;
  try {
    const result = await client.messages.create({
      body: message,
      from: twilioPhone,
      to: to,
    });
    res.json({ success: true, sid: result.sid });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// MMS (with logo image)
app.post("/send-mms", async (req, res) => {
  const { to, message, mediaUrl } = req.body;
  try {
    const result = await client.messages.create({
      body: message,
      from: twilioPhone,
      to: to,
      mediaUrl: [mediaUrl],
    });
    res.json({ success: true, sid: result.sid });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Create auth user without signing in (admin API)
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
  if (!supabaseUrl || !serviceKey) {
    return res.json({ success: false, error: "Supabase admin credentials not configured" });
  }
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        email,
        password: password || ("TempPass_" + Math.random().toString(36).slice(2, 10) + "!1"),
        email_confirm: true,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      // If user already exists, that's fine
      if (data.msg && data.msg.includes("already been registered")) {
        return res.json({ success: true, existing: true });
      }
      return res.json({ success: false, error: data.msg || data.message || "Error creating user" });
    }
    res.json({ success: true, user: data });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Handle CORS preflight for send-invite
app.options("/send-invite", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

// Send client invite email via Resend
app.post("/send-invite", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { email, businessName } = req.body;
  if (!email || !businessName) {
    return res.json({ success: false, error: "Missing email or businessName" });
  }
  if (!resendApiKey) {
    return res.json({ success: false, error: "Resend API key not configured" });
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${resendApiKey}`,
      },
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
              <p style="font-size: 15px; color: rgba(13,17,23,0.6); line-height: 1.7; margin: 0 0 24px;">
                Your ReviewSend account for <strong>${businessName}</strong> has been created by your marketing partner.
              </p>
              <p style="font-size: 15px; color: rgba(13,17,23,0.6); line-height: 1.7; margin: 0 0 32px;">
                Click the button below to set your password and access your dashboard.
              </p>
              <div style="text-align: center; margin-bottom: 32px;">
                <a href="https://reviewsend-app-lilac.vercel.app" style="display: inline-block; background: #1A5FBF; color: #fff; padding: 14px 36px; border-radius: 8px; font-size: 15px; font-weight: 600; text-decoration: none;">
                  Set Up My Account →
                </a>
              </div>
              <p style="font-size: 13px; color: rgba(13,17,23,0.4); text-align: center; margin: 0;">
                Questions? Contact your account manager or email us at support.reviewsend@gmail.com
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

app.get("/", (req, res) => {
  res.send("ReviewSend server is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server is running on port " + PORT);
});
