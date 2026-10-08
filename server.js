require("dotenv").config();

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// =====================================================
// FIREBASE
// =====================================================
function initializeFirebase() {
  if (admin.apps.length) return;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const serviceAccount = JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      );

      if (serviceAccount.private_key) {
        serviceAccount.private_key =
          serviceAccount.private_key.replace(/\\n/g, "\n");
      }

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });

      console.log("Firebase Admin initialized using service account.");
      return;
    } catch (error) {
      console.error(
        "FIREBASE_SERVICE_ACCOUNT_JSON is invalid:",
        error.message
      );
      throw error;
    }
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });

  console.log(
    "Firebase Admin initialized using application default credentials."
  );
}

initializeFirebase();

const db = admin.firestore();
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

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
// HELPERS
// =====================================================
function normalizeWhatsAppNumber(value) {
  let digits = String(value || "").replace(/\D/g, "");

  if (!digits) return "";

  if (digits.length === 10) {
    digits = "91" + digits;
  }

  if (digits.length === 13 && digits.startsWith("091")) {
    digits = digits.substring(1);
  }

  return digits;
}

function money(value) {
  const n = Number(value || 0);
  return `₹${n.toFixed(2)}`;
}

function safeText(value, fallback = "-") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function requireApiKey(req, res, next) {
  if (!BACKEND_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "BACKEND_API_KEY is not configured on server",
    });
  }

  const receivedKey = req.get("x-api-key");

  if (!receivedKey || receivedKey !== BACKEND_API_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  next();
}

// =====================================================
// HOME / HEALTH
// =====================================================
app.get("/", (req, res) => {
  res.status(200).send("VIBELO WhatsApp Backend is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "VIBELO WhatsApp Backend",
    firebase: admin.apps.length > 0,
    whatsappConfigured: Boolean(
      WHATSAPP_TOKEN && PHONE_NUMBER_ID
    ),
  });
});

// =====================================================
// META WEBHOOK VERIFY
// =====================================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token &&
    VERIFY_TOKEN &&
    token === VERIFY_TOKEN
  ) {
    console.log("WEBHOOK VERIFIED");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// =====================================================
// SEND WHATSAPP MESSAGE
// =====================================================
async function sendWhatsAppMessage(to, message) {
  if (!WHATSAPP_TOKEN) {
    throw new Error("WHATSAPP_TOKEN is not configured");
  }

  if (!PHONE_NUMBER_ID) {
    throw new Error("PHONE_NUMBER_ID is not configured");
  }

  const customerNumber = normalizeWhatsAppNumber(to);

  if (!customerNumber) {
    throw new Error("Customer WhatsApp number is missing");
  }

  const body = String(message || "").trim();

  if (!body) {
    throw new Error("WhatsApp message is empty");
  }

  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/` +
    `${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: customerNumber,
      type: "text",
      text: {
        preview_url: false,
        body,
      },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(
      "Meta WhatsApp API error:",
      JSON.stringify(data)
    );

    throw new Error(
      data?.error?.message ||
      "Meta WhatsApp API request failed"
    );
  }

  console.log(
    "WhatsApp message accepted by Meta:",
    customerNumber,
    data?.messages?.[0]?.id || ""
  );

  return data;
}

// =====================================================
// FINAL BILL FORMAT
// =====================================================
function buildFinalBillMessage(data) {
  const customerName = safeText(
    data.customerName || data.name,
    "Customer"
  );

  const pickup = safeText(data.pickup);
  const drop = safeText(data.drop);

  const totalKM = Number(data.totalKM || 0).toFixed(1);
  const kmFare = Number(data.kmFare || 0);
  const driverBata = Number(data.driverBata || 0);
  const toll = Number(data.toll || 0);
  const parking = Number(data.parking || 0);
  const permit = Number(data.permit || 0);
  const hill = Number(data.hill || 0);
  const totalFare = Number(data.totalFare || 0);

  const paymentStatus = safeText(
    data.customerPaymentStatus || data.paymentStatus,
    "Pending"
  );

  const paymentMethod = safeText(
    data.customerPaymentMethod || data.paymentMode,
    "Not specified"
  );

  return [
    "🚕 VIBELO Tours and Travels",
    "",
    "FINAL TRIP BILL",
    "",
    `Customer: ${customerName}`,
    `Pickup: ${pickup}`,
    `Drop: ${drop}`,
    "",
    `Total KM: ${totalKM} KM`,
    `KM Fare: ${money(kmFare)}`,
    `Driver Bata: ${money(driverBata)}`,
    `Toll: ${money(toll)}`,
    `Parking: ${money(parking)}`,
    `Permit: ${money(permit)}`,
    `Hill Charges: ${money(hill)}`,
    "",
    `TOTAL FARE: ${money(totalFare)}`,
    "",
    `Payment Status: ${paymentStatus}`,
    `Payment Method: ${paymentMethod}`,
    "",
    "Thank you for travelling with VIBELO.",
  ].join("\n");
}

// =====================================================
// INCOMING WHATSAPP WEBHOOK / AUTO REPLY
// =====================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const value =
      req.body?.entry?.[0]?.changes?.[0]?.value;

    // META DELIVERY STATUS LOGGING
    // Logs sent / delivered / read / failed events returned by Meta.
    const statuses = value?.statuses;

    if (Array.isArray(statuses) && statuses.length > 0) {
      for (const status of statuses) {
        console.log(
          "WHATSAPP DELIVERY STATUS:",
          JSON.stringify({
            id: status?.id || "",
            status: status?.status || "",
            recipient_id: status?.recipient_id || "",
            timestamp: status?.timestamp || "",
            errors: status?.errors || [],
          })
        );

        // Keep Firestore in sync with the REAL Meta delivery status.
        // Meta first accepts a message, then later reports sent/delivered/read/failed.
        const metaMessageId = String(status?.id || "").trim();
        const metaDeliveryStatus = String(status?.status || "").trim();

        if (metaMessageId && metaDeliveryStatus) {
          try {
            const matchingOutbox = await db
              .collection("whatsappOutbox")
              .where("metaMessageId", "==", metaMessageId)
              .limit(1)
              .get();

            if (!matchingOutbox.empty) {
              const outboxDoc = matchingOutbox.docs[0];
              const outboxData = outboxDoc.data() || {};
              const enquiryId =
                outboxData.enquiryId || outboxData.dutyId || "";

              const updateData = {
                metaDeliveryStatus,
                metaStatusUpdatedAt:
                  admin.firestore.FieldValue.serverTimestamp(),
                updatedAt:
                  admin.firestore.FieldValue.serverTimestamp(),
              };

              if (metaDeliveryStatus === "delivered") {
                updateData.customerDeliveryStatus = "Delivered";
                updateData.deliveredAt =
                  admin.firestore.FieldValue.serverTimestamp();
              } else if (metaDeliveryStatus === "read") {
                updateData.customerDeliveryStatus = "Read";
                updateData.readAt =
                  admin.firestore.FieldValue.serverTimestamp();
              } else if (metaDeliveryStatus === "sent") {
                updateData.customerDeliveryStatus = "Sent";
              } else if (metaDeliveryStatus === "failed") {
                updateData.status = "Failed";
                updateData.customerDeliveryStatus = "Failed";
                updateData.lastError = JSON.stringify(
                  status?.errors || []
                ).slice(0, 1000);
                updateData.failedAt =
                  admin.firestore.FieldValue.serverTimestamp();
              }
const finalDeliveryStatus = {
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed"
}[metaDeliveryStatus];

if (finalDeliveryStatus) {
  updateData.status = finalDeliveryStatus;
}

              await outboxDoc.ref.update(updateData);

              if (enquiryId) {
                const enquiryUpdate = {
                  whatsappMetaDeliveryStatus: metaDeliveryStatus,
                  whatsappStatusUpdatedAt:
                    admin.firestore.FieldValue.serverTimestamp(),
                };

                if (metaDeliveryStatus === "delivered") {
                  enquiryUpdate.customerBillDeliveryStatus = "Delivered";
                  enquiryUpdate.whatsappQueueStatus = "Delivered";
                  enquiryUpdate.whatsappDeliveredAt =
                    admin.firestore.FieldValue.serverTimestamp();
                } else if (metaDeliveryStatus === "read") {
                  enquiryUpdate.customerBillDeliveryStatus = "Read";
                  enquiryUpdate.whatsappQueueStatus = "Read";
                  enquiryUpdate.whatsappReadAt =
                    admin.firestore.FieldValue.serverTimestamp();
                } else if (metaDeliveryStatus === "sent") {
                  enquiryUpdate.customerBillDeliveryStatus = "Sent";
                  enquiryUpdate.whatsappQueueStatus = "Sent";
                } else if (metaDeliveryStatus === "failed") {
                  enquiryUpdate.customerBillDeliveryStatus = "Failed";
                  enquiryUpdate.whatsappQueueStatus = "Failed";
                  enquiryUpdate.whatsappLastError = JSON.stringify(
                    status?.errors || []
                  ).slice(0, 500);
                }

                await db
                  .collection("enquiries")
                  .doc(String(enquiryId))
                  .set(enquiryUpdate, { merge: true });
              }
            } else {
              console.warn(
                "No whatsappOutbox document found for Meta message:",
                metaMessageId
              );
            }
          } catch (statusUpdateError) {
            console.error(
              "Meta delivery status Firestore update error:",
              statusUpdateError
            );
          }
        }

        if (status?.status === "failed") {
          console.error(
            "WHATSAPP DELIVERY FAILED:",
            JSON.stringify(status?.errors || [])
          );
        }
      }
    }

    const messages = value?.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }

    for (const incoming of messages) {
      const from = normalizeWhatsAppNumber(incoming?.from);

      if (!from) continue;

      if (incoming?.type !== "text") {
        await sendWhatsAppMessage(
          from,
          [
            "Welcome to VIBELO Tours and Travels.",
            "",
            "Please type your trip details:",
            "Pickup:",
            "Drop:",
            "Journey Date:",
            "Journey Time:",
          ].join("\n")
        );
        continue;
      }

      const incomingText = String(
        incoming?.text?.body || ""
      )
        .trim()
        .toLowerCase();

      const greetings = ["hi", "hello", "hai", "hey", "hii"];

      if (greetings.includes(incomingText)) {
        await sendWhatsAppMessage(
          from,
          [
            "Welcome to VIBELO Tours and Travels 🚕",
            "",
            "Premium Taxi & Tour Booking Service",
            "",
            "Please send:",
            "Pickup Location",
            "Drop Location",
            "Journey Date",
            "Journey Time",
            "",
            "Our team will assist you shortly.",
          ].join("\n")
        );
      } else {
        await sendWhatsAppMessage(
          from,
          [
            "Thank you for contacting VIBELO.",
            "",
            "Please send your trip details:",
            "Pickup:",
            "Drop:",
            "Journey Date:",
            "Journey Time:",
          ].join("\n")
        );
      }
    }
  } catch (error) {
    console.error("Webhook processing error:", error);
  }
});

// =====================================================
// DIRECT SEND ENDPOINT
// =====================================================
app.post("/send-whatsapp", requireApiKey, async (req, res) => {
  try {
    const { to, message } = req.body || {};

    if (!to || !message) {
      return res.status(400).json({
        ok: false,
        error: "to and message are required",
      });
    }

    const result = await sendWhatsAppMessage(to, message);

    return res.status(200).json({
      ok: true,
      result,
    });
  } catch (error) {
    console.error("send-whatsapp error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// =====================================================
// BOOKING CONFIRMATION
// =====================================================
app.post(
  "/send-booking-confirmation",
  requireApiKey,
  async (req, res) => {
    try {
      const {
        to,
        customerName,
        bookingId,
        pickup,
        drop,
        journeyDate,
        journeyTime,
        vehicle,
        totalFare,
      } = req.body || {};

      if (!to) {
        return res.status(400).json({
          ok: false,
          error: "Customer WhatsApp number is required",
        });
      }

      const message = [
        "🚕 VIBELO Tours and Travels",
        "",
        "BOOKING CONFIRMED",
        "",
        `Customer: ${safeText(customerName, "Customer")}`,
        `Booking ID: ${safeText(bookingId)}`,
        `Pickup: ${safeText(pickup)}`,
        `Drop: ${safeText(drop)}`,
        `Journey Date: ${safeText(journeyDate)}`,
        `Journey Time: ${safeText(journeyTime)}`,
        `Vehicle: ${safeText(vehicle)}`,
        `Fare: ${money(totalFare)}`,
        "",
        "Thank you for choosing VIBELO.",
      ].join("\n");

      const result = await sendWhatsAppMessage(to, message);

      return res.status(200).json({
        ok: true,
        result,
      });
    } catch (error) {
      console.error("Booking confirmation error:", error);

      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

// =====================================================
// OUTBOX PROCESSING
// =====================================================
async function claimOutboxItem(docRef) {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(docRef);

    if (!snapshot.exists) return null;

    const data = snapshot.data();

    if (data.status !== "Pending") return null;

    transaction.update(docRef, {
      status: "Processing",
      processingStartedAt:
        admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:
        admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      id: snapshot.id,
      ...data,
    };
  });
}

async function processFinalBillDocument(docRef) {
  const item = await claimOutboxItem(docRef);

  if (!item) {
    return {
      processed: false,
      reason: "Document is no longer Pending",
    };
  }

  try {
    if (item.type !== "FINAL_BILL") {
      throw new Error(
        `Unsupported outbox type: ${item.type || "EMPTY"}`
      );
    }

    const customerPhone = normalizeWhatsAppNumber(
      item.customerPhone
    );

    if (!customerPhone) {
      throw new Error("Customer WhatsApp number is missing");
    }

    const message = buildFinalBillMessage(item);

    console.log(
      "Processing FINAL_BILL:",
      item.id,
      customerPhone
    );
const metaResult = await sendWhatsAppTemplateMessage(
  customerPhone,
  "vibelo_final_bill",
  "en",
  buildFinalBillTemplateParams(item)
);

    const messageId =
      metaResult?.messages?.[0]?.id || "";

    await docRef.update({
      status: "Accepted",
      sendAttempts:
        admin.firestore.FieldValue.increment(1),
      lastError: "",
      metaMessageId: messageId,
      sentAt:
        admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:
        admin.firestore.FieldValue.serverTimestamp(),
    });

    // Driver file currently queues enquiryId.
    // Older records may contain dutyId, so support both.
    const enquiryId = item.enquiryId || item.dutyId || "";

    if (enquiryId) {
      try {
        const enquiryRef = db
          .collection("enquiries")
          .doc(String(enquiryId));

        await enquiryRef.set(
          {
           customerBillDeliveryStatus: "Accepted",
            whatsappSentAt:
              admin.firestore.FieldValue.serverTimestamp(),
            whatsappMetaMessageId: messageId,
          },
          { merge: true }
        );
      } catch (enquiryError) {
        console.error(
          "Enquiry status update error:",
          enquiryError
        );
      }
    }

    return {
      processed: true,
      sent: true,
      id: item.id,
      metaMessageId: messageId,
    };
  } catch (error) {
    console.error("Final bill send error:", error);

    await docRef.update({
      status: "Failed",
      sendAttempts:
        admin.firestore.FieldValue.increment(1),
      lastError: String(
        error.message || error
      ).slice(0, 1000),
      failedAt:
        admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:
        admin.firestore.FieldValue.serverTimestamp(),
    });

    const enquiryId = item.enquiryId || item.dutyId || "";

    if (enquiryId) {
      try {
        await db
          .collection("enquiries")
          .doc(String(enquiryId))
          .set(
            {
              customerBillDeliveryStatus: "Failed",
              whatsappQueueStatus: "Failed",
              whatsappLastError: String(
                error.message || error
              ).slice(0, 500),
            },
            { merge: true }
          );
      } catch (enquiryError) {
        console.error(
          "Failed enquiry update error:",
          enquiryError
        );
      }
    }

    return {
      processed: true,
      sent: false,
      id: item.id,
      error: error.message,
    };
  }
}

async function processWhatsAppOutbox(limit = 10) {
  const snapshot = await db
    .collection("whatsappOutbox")
    .where("status", "==", "Pending")
    .limit(limit)
    .get();

  if (snapshot.empty) {
    return {
      checked: 0,
      sent: 0,
      failed: 0,
      results: [],
    };
  }

  const results = [];

  for (const document of snapshot.docs) {
    const result = await processFinalBillDocument(
      document.ref
    );
    results.push(result);
  }

  return {
    checked: results.length,
    sent: results.filter((x) => x.sent === true).length,
    failed: results.filter(
      (x) =>
        x.processed === true &&
        x.sent === false
    ).length,
    results,
  };
}

// =====================================================
// MANUAL OUTBOX PROCESSING ENDPOINTS
// =====================================================
let outboxProcessing = false;

app.post(
  "/process-whatsapp-outbox",
  async (req, res) => {
    if (outboxProcessing) {
      return res.status(202).json({
        ok: true,
        message:
          "WhatsApp outbox processing is already running",
      });
    }

    outboxProcessing = true;

    try {
      const result = await processWhatsAppOutbox(10);

      return res.status(200).json({
        ok: true,
        ...result,
      });
    } catch (error) {
      console.error("Outbox processing error:", error);

      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    } finally {
      outboxProcessing = false;
    }
  }
);

app.post(
  "/admin/process-whatsapp-outbox",
  requireApiKey,
  async (req, res) => {
    try {
      const result = await processWhatsAppOutbox(20);

      return res.status(200).json({
        ok: true,
        ...result,
      });
    } catch (error) {
      console.error(
        "Admin outbox processing error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);

// =====================================================
// AUTOMATIC OUTBOX PROCESSOR
// Checks Firestore every 5 seconds.
// Prevents overlapping runs with the same lock.
// =====================================================
const OUTBOX_INTERVAL_MS = 5000;

async function runAutomaticOutboxProcessor() {
  if (outboxProcessing) return;

  outboxProcessing = true;

  try {
    const result = await processWhatsAppOutbox(20);

    if (result.checked > 0) {
      console.log(
        `WhatsApp outbox: checked=${result.checked}, sent=${result.sent}, failed=${result.failed}`
      );
    }
  } catch (error) {
    console.error(
      "Automatic WhatsApp outbox processing error:",
      error
    );
  } finally {
    outboxProcessing = false;
  }
}

setInterval(
  runAutomaticOutboxProcessor,
  OUTBOX_INTERVAL_MS
);

// Also run once shortly after server startup.
setTimeout(
  runAutomaticOutboxProcessor,
  2000
);

// =====================================================
// PRIVACY
// =====================================================
app.get("/privacy", (req, res) => {
  res.type("html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >
  <title>VIBELO Privacy Policy</title>
</head>
<body
  style="
    font-family:Arial,sans-serif;
    max-width:850px;
    margin:40px auto;
    padding:20px;
    line-height:1.7;
  "
>
  <h1>VIBELO Privacy Policy</h1>

  <p>
    VIBELO Tours and Travels uses customer
    information only for booking, trip,
    customer support and service communication
    purposes.
  </p>

  <p>
    Customer information is not sold to
    third parties.
  </p>

  <p>
    WhatsApp may be used to provide booking
    information, trip updates and final bill
    communication related to VIBELO services.
  </p>

  <p>
    Customers may contact VIBELO for questions
    regarding their information.
  </p>
</body>
</html>
  `);
});

// =====================================================
// 404
// =====================================================
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Route not found",
  });
});

// =====================================================
// START SERVER
// =====================================================
app.listen(PORT, () => {
  console.log(
    `VIBELO WhatsApp Backend running on port ${PORT}`
  );
});

async function sendWhatsAppTemplateMessage(
  to,
  templateName,
  language,
  parameters
) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error("Meta WhatsApp settings are missing");
  }

  const customerNumber = normalizeWhatsAppNumber(to);

  if (!customerNumber) {
    throw new Error("Customer WhatsApp number is missing");
  }

  if (!Array.isArray(parameters) || !parameters.length) {
    throw new Error("Final bill template parameters are missing");
  }

  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/` +
    `${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: customerNumber,
      type: "template",
      template: {
        name: templateName,
        language: {
          code: language,
        },
        components: [
          {
            type: "body",
            parameters: parameters,
          },
        ],
      },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(
      "Final Bill Template Error:",
      JSON.stringify(data)
    );

    throw new Error(
      data?.error?.message ||
      "WhatsApp Template sending failed"
    );
  }

  return data;
}

function buildFinalBillTemplateParams(item) {
  const p = item.templateParameters || {};

  const value = (...items) => {
    const found = items.find(
      v => v !== undefined &&
           v !== null &&
           String(v).trim() !== ""
    );
    return String(found ?? "-");
  };

  const txt = v => ({
    type: "text",
    text: String(v)
  });

  return [
    txt(value(p.customerName, item.customerName, "Customer")),
    txt(value(p.driverName, item.driverName, "-")),
    txt(value(p.vehicle, item.vehicleNumber, "-")),
    txt(value(p.pickup, item.pickup, "-")),
    txt(value(p.drop, item.drop, "-")),
    txt(value(p.totalKM, item.totalKM, "-")),
    txt(value(p.kmFare, item.kmFare, "-")),
    txt(value(p.driverBata, item.driverBata, "-")),
    txt(value(p.toll, item.toll, "0")),
    txt(value(p.parking, item.parking, "0")),
    txt(value(p.permit, item.permit, "0")),
    txt(value(p.hill, item.hill, "0")),
    txt(value(p.extraCharges, item.extraCharges, "0")),
    txt(value(p.grossFare, item.grossTripAmount, item.totalFare, "-")),
    txt(value(p.cashbackUsed, item.cashbackWalletUsed, item.cashbackUsed, "0")),
    txt(value(p.finalPayable, item.finalAmountToPay, item.customerFinalPayable, item.totalFare, "-")),
    txt(value(p.paymentStatus, item.customerPaymentStatus, "-")),
    txt(value(p.paymentMethod, item.customerPaymentMethod, "-")),
    txt(value(p.cashbackEarned, item.cashbackEarned, "0"))
  ];
}
