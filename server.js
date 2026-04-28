const express = require("express");
const twilio = require("twilio");
const cors = require("cors");

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.options("*", cors());
app.use(express.json());

const accountSid = process.env.ACCOUNT_SID;
const authToken = process.env.AUTH_TOKEN;
const twilioPhone = process.env.TWILIO_PHONE;

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

app.get("/", (req, res) => {
  res.send("ReviewSend server is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server is running on port " + PORT);
});
