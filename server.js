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
    .send("VIBELO WhatsApp Backend is running");
});


// =====================================================
// 2. HEALTH CHECK
// =====================================================

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "VIBELO WhatsApp Backend"
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

  const cleanNumber =
    String(to).replace(/[^\d]/g, "");

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
      to: cleanNumber,
      type: "text",
      text: {
        preview_url: false,
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
    const change = entry?.changes?.[0];
    const value = change?.value;

    const incomingMessage =
      value?.messages?.[0];

    // Status / delivery / read event
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


      // ===============================================
      // PREMIUM WELCOME MESSAGE
      // ===============================================

      if (
        lowerText === "hi" ||
        lowerText === "hello" ||
        lowerText === "hai" ||
        lowerText === "hey" ||
        lowerText === "hii"
      ) {

        const reply =
  "✨ Thank you for choosing VIBELO Tours & Travels.\n\n" +
  "We've received your message successfully.\n" +
  "Our Customer Care Team will be in touch with you shortly.\n\n" +
  "Thank you for trusting VIBELO. 💙\n" +
  "Your Journey, Our Priority.";

        await sendWhatsAppMessage(
          customerNumber,
          reply
        );

        console.log(
          "VIBELO premium welcome reply sent successfully"
        );

        return;
      }


      // ===============================================
      // GENERAL CUSTOMER MESSAGE
      // ===============================================

      const reply =
        "✨ *Thank You for Contacting VIBELO* ✨\n\n" +
        "Your travel request has been received.\n\n" +
        "Please share your Pickup Location, Drop Location and Journey Date & Time.\n\n" +
        "Our team will assist you shortly.\n\n" +
        "👑 *VIBELO Tours & Travels*\n" +
        "Your Journey. Our Priority.";

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
      "✨ *Thank You for Contacting VIBELO* ✨\n\n" +
      "Please type your Pickup Location, Drop Location and Journey Date & Time.\n\n" +
      "👑 *VIBELO Tours & Travels*";

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
// 5. SEND MESSAGE FROM VIBELO SYSTEM
// Booking Confirmation / Bill / Wallet Reward
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
// 6. PRIVACY POLICY
// =====================================================

app.get("/privacy", (req, res) => {

  res.send(`
    <!DOCTYPE html>
    <html lang="en">

    <head>
      <meta charset="UTF-8">
      <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
      >

      <title>
        Privacy Policy - VIBELO Tours and Travels
      </title>
    </head>

    <body
      style="
        font-family:Arial,sans-serif;
        max-width:850px;
        margin:40px auto;
        padding:20px;
        line-height:1.6;
      "
    >

      <h1>Privacy Policy</h1>

      <h2>VIBELO Tours and Travels</h2>

      <p>
        <strong>Effective date:</strong>
        05 October 2026
      </p>

      <p>
        VIBELO Tours and Travels respects your privacy
        and is committed to protecting the personal
        information you provide while using our travel,
        taxi and booking services.
      </p>

      <h3>Information We Collect</h3>

      <p>
        We may collect information such as your name,
        mobile number, WhatsApp number, pickup and drop
        locations, journey details, booking details and
        other information necessary to provide our services.
      </p>

      <h3>How We Use Your Information</h3>

      <p>
        We use this information to process enquiries and
        bookings, communicate with customers, provide trip
        updates, assign suitable service providers, provide
        customer support and improve our services.
      </p>

      <h3>WhatsApp Communication</h3>

      <p>
        When you communicate with VIBELO through WhatsApp,
        we may process your messages and contact details
        to respond to enquiries, provide booking assistance
        and send service-related communications.
      </p>

      <h3>Information Sharing</h3>

      <p>
        We may share necessary booking information with
        drivers, partners or service providers only when
        required to provide the requested service.
        We do not sell personal information.
      </p>

      <h3>Data Security</h3>

      <p>
        We take reasonable measures to protect personal
        information from unauthorized access, misuse or
        disclosure.
      </p>

      <h3>Data Retention and Deletion</h3>

      <p>
        We retain information only as necessary for
        providing our services, maintaining records and
        meeting applicable legal requirements.
        Customers may contact us to request deletion of
        their personal information, subject to applicable
        legal and operational requirements.
      </p>

      <h3>Contact Us</h3>

      <p>
        For privacy questions or data deletion requests,
        please contact VIBELO Tours and Travels through
        our official customer support channels.
      </p>

      <p>
        <strong>Last updated:</strong>
        05 October 2026
      </p>

    </body>
    </html>
  `);
});


// =====================================================
// 7. START SERVER
// =====================================================

app.listen(PORT, () => {

  console.log(
    `VIBELO WhatsApp Backend running on port ${PORT}`
  );

});
