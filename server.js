require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Meta / WhatsApp settings
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION;

// Protect our send API
const BACKEND_API_KEY = process.env.BACKEND_API_KEY;


// =====================================================
// 1. HOME TEST
// =====================================================

app.get("/", (req, res) => {
  res.status(200).send("VIBLO WhatsApp Backend is running");
});


// =====================================================
// 2. HEALTH CHECK
// =====================================================

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "VIBLO WhatsApp Backend"
  });
});


// =====================================================
// 3. META WEBHOOK VERIFICATION
// =====================================================

app.get("/webhook", (req, res) => {

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token &&
    token === VERIFY_TOKEN
  ) {

    console.log("Webhook verified successfully");

    return res.status(200).send(challenge);
  }

  console.log("Webhook verification failed");

  return res.sendStatus(403);
});


// =====================================================
// 4. RECEIVE WHATSAPP WEBHOOK EVENTS
// =====================================================

app.post("/webhook", (req, res) => {

  console.log(
    "WhatsApp Webhook Event:",
    JSON.stringify(req.body, null, 2)
  );

  // Meta expects HTTP 200 quickly
  return res.sendStatus(200);
});


// =====================================================
// 5. SEND WHATSAPP TEXT MESSAGE
// =====================================================

app.post("/send-whatsapp", async (req, res) => {

  // Protect this endpoint
  const receivedApiKey = req.get("x-api-key");

  if (
    !BACKEND_API_KEY ||
    receivedApiKey !== BACKEND_API_KEY
  ) {

    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }


  const { to, message } = req.body || {};


  if (!to || !message) {

    return res.status(400).json({
      success: false,
      error: "Phone number and message are required"
    });
  }


  if (
    !WHATSAPP_TOKEN ||
    !PHONE_NUMBER_ID ||
    !GRAPH_API_VERSION
  ) {

    return res.status(500).json({
      success: false,
      error: "WhatsApp server configuration is incomplete"
    });
  }


  try {

    const url =
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;


    const response = await fetch(url, {

      method: "POST",

      headers: {

        "Authorization":
          `Bearer ${WHATSAPP_TOKEN}`,

        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({

        messaging_product: "whatsapp",

        recipient_type: "individual",

        to: to,

        type: "text",

        text: {
          body: message
        }

      })

    });


    const data = await response.json();


    if (!response.ok) {

      console.error(
        "WhatsApp API Error:",
        data
      );

      return res
        .status(response.status)
        .json({
          success: false,
          whatsapp: data
        });
    }


    console.log(
      "WhatsApp message sent:",
      data
    );


    return res.status(200).json({

      success: true,

      whatsapp: data

    });


  } catch (error) {

    console.error(
      "WhatsApp Send Error:",
      error
    );


    return res.status(500).json({

      success: false,

      error:
        "Unable to send WhatsApp message"

    });

  }

});


// =====================================================
// 6. START SERVER
// =====================================================

app.listen(PORT, () => {

  console.log(
    `VIBLO WhatsApp Backend running on port ${PORT}`
  );

});
