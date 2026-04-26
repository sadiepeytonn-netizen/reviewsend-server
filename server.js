const express = require("express");
const twilio = require("twilio");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const accountSid = "AC96d85180675dcb1fff96bebc096b4868";
const authToken = "0b30904095ffe3b7ce4c627c37e5d6b5";
const twilioPhone = "+17403138050";

const client = twilio(accountSid, authToken);

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

app.get("/", (req, res) => {
  res.send("ReviewSend server is running!");
});

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
