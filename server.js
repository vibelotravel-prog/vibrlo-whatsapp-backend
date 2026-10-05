require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// =====================================================
// META / WHATSAPP SETTINGS
// =====================================================

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// Render-ல் நீங்கள் வைத்துள்ள பெயர்களையும் support செய்யும்
const PHONE_NUMBER_ID =
  process.env.PHONE_NUMBER_ID ||
  process.env.WHATSAPP_PHONE_NUMBER_ID;

const GRAPH_API_VERSION =
  process.env.GRAPH_API_VERSION || "v26.0";

const BACKEND_API_KEY = process.env.BACKEND_API_KEY;


// =====================================================
// 1. HOME TEST
// =====================================================

app.get("/", (req, res) => {
  res
    .status(200)
    .send("VIBLO WhatsApp Backend is running");
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
// HELPER - SEND WHATSAPP MESSAGE
// =====================================================

async function sendWhatsAppMessage(to, message) {

  if (!WHATSAPP_TOKEN) {
    throw new Error("WHATSAPP_TOKEN is missing");
  }

  if (!PHONE_NUMBER_ID) {
    throw new Error("PHONE_NUMBER_ID is missing");
  }

  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {

    method: "POST",

    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
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
      JSON.stringify(data, null, 2)
    );

    throw new Error(
      data?.error?.message ||
      "WhatsApp API request failed"
    );
  }

  console.log(
    "WhatsApp message sent:",
    JSON.stringify(data, null, 2)
  );

  return data;
}


// =====================================================
// 4. RECEIVE WHATSAPP MESSAGE + AUTO REPLY
// =====================================================

app.post("/webhook", async (req, res) => {

  // Meta expects HTTP 200 quickly
  res.sendStatus(200);

  console.log(
    "WhatsApp Webhook Event:",
    JSON.stringify(req.body, null, 2)
  );

  try {

    const entry = req.body?.entry?.[0];

    const change =
      entry?.changes?.[0];

    const value =
      change?.value;

    const incomingMessage =
      value?.messages?.[0];

    // Delivery/read/status webhook என்றால் reply வேண்டாம்
    if (!incomingMessage) {

      console.log(
        "Webhook received - no incoming customer message"
      );

      return;
    }

    const customerNumber =
      incomingMessage.from;

    const messageType =
      incomingMessage.type;

    console.log(
      "Incoming customer:",
      customerNumber
    );

    console.log(
      "Incoming type:",
      messageType
    );


    // =================================================
    // TEXT MESSAGE
    // =================================================

    if (messageType === "text") {

      const customerText =
        incomingMessage.text?.body?.trim() || "";

      console.log(
        "Customer message:",
        customerText
      );

      const lowerText =
        customerText.toLowerCase();


      // -----------------------------------------------
      // HI / HELLO AUTO REPLY
      // -----------------------------------------------

      if (
        lowerText === "hi" ||
        lowerText === "hello" ||
        lowerText === "hai" ||
        lowerText === "hey" ||
        lowerText === "hii"
      ) {

        const reply =
          "Welcome to VIBELO! 🚕\n\n" +
          "Thank you for contacting us.\n\n" +
          "Please send your Pickup Location and Drop Location.\n\n" +
          "Example:\n" +
          "Pickup: Madurai\n" +
          "Drop: Chennai";

        await sendWhatsAppMessage(
          customerNumber,
          reply
        );

        console.log(
          "VIBELO welcome auto reply sent successfully"
        );

        return;
      }


      // -----------------------------------------------
      // OTHER CUSTOMER TEXT
      // -----------------------------------------------

      const reply =
        "Thank you for contacting VIBELO! 🚕\n\n" +
        "Please send your Pickup Location and Drop Location.\n\n" +
        "Example:\n" +
        "Pickup: Madurai\n" +
        "Drop: Chennai";

      await sendWhatsAppMessage(
        customerNumber,
        reply
      );

      console.log(
        "VIBELO general auto reply sent successfully"
      );

      return;
    }


    // =================================================
    // NON-TEXT MESSAGE
    // =================================================

    const reply =
      "Thank you for contacting VIBELO! 🚕\n\n" +
      "Please type your Pickup Location and Drop Location.";

    await sendWhatsAppMessage(
      customerNumber,
      reply
    );

    console.log(
      "VIBELO non-text auto reply sent successfully"
    );

  } catch (error) {

    console.error(
      "WEBHOOK AUTO REPLY ERROR:",
      error
    );
  }
});


// =====================================================
// 5. SEND WHATSAPP MESSAGE FROM VIBELO SYSTEM
// =====================================================

app.post("/send-whatsapp", async (req, res) => {

  const receivedApiKey =
    req.get("x-api-key");

  if (
    !BACKEND_API_KEY ||
    receivedApiKey !== BACKEND_API_KEY
  ) {

    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }


  const { to, message } =
    req.body || {};


  if (!to || !message) {

    return res.status(400).json({
      success: false,
      error:
        "Phone number and message are required"
    });
  }


  try {

    const data =
      await sendWhatsAppMessage(
        to,
        message
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
      error: error.message
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
