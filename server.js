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
app.use("/api/sms-otp", require("./sms_otp"));
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
            // Meta can deliver its webhook before the send endpoint saves
            // the message ID in Firestore. Retry the lookup briefly.
            let matchingOutbox;
            for (let attempt = 0; attempt < 5; attempt++) {
              matchingOutbox = await db
                .collection("whatsappOutbox")
                .where("metaMessageId", "==", metaMessageId)
                .limit(1)
                .get();
              if (!matchingOutbox.empty) break;
              if (attempt < 4) {
                await new Promise(resolve => setTimeout(resolve, 400));
              }
            }

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
  "🚕 VIBELO DROP TAXI",
  "",
  "Thank you for choosing VIBELO Drop Taxi!",
  "",
  "Our customer care executive will contact you shortly to assist with your booking.",
  "",
  "Your Journey, Our Priority. ✨"
].join("\n")
        );
      } else {
        await sendWhatsAppMessage(
          from,
          [
          
  "Thank you for choosing VIBELO Drop Taxi.",
  "",
  "For bookings and assistance, contact VIBELO Customer Care."
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
 requireApiKey, async (req, res) => {
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
// BOLNA AI -> FIREBASE ENQUIRY (ADDITIVE MODULE)
// No changes to WhatsApp, billing, or existing staff assignment.
// This endpoint stores a NEW, UNASSIGNED enquiry.
// Existing staff assignment logic must be verified separately.
// =====================================================

// Use a separate secret for the AI service instead of exposing the
// general BACKEND_API_KEY (which authorizes other backend functions).
const BOLNA_ENQUIRY_API_KEY = process.env.BOLNA_ENQUIRY_API_KEY;

function requireBolnaApiKey(req, res, next) {
  if (!BOLNA_ENQUIRY_API_KEY) {
    return res.status(503).json({
      ok: false,
      error: "Bolna enquiry integration has not been configured"
    });
  }

  const receivedKey = req.get("x-bolna-api-key");
  if (!receivedKey || receivedKey !== BOLNA_ENQUIRY_API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

function bolnaText(value, maxLength = 240) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function bolnaDateToISO(value) {
  const input = bolnaText(value, 32);
  let year, month, day;
  let match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    [, year, month, day] = match;
  } else {
    match = input.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!match) return null;
    [, day, month, year] = match;
  }

  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    return null;
  }
  return iso;
}

function bolnaTimeTo24Hour(value) {
  const input = bolnaText(value, 32).toLowerCase().replace(/\./g, ":");
  const match = input.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59) return null;
  const meridiem = match[3];
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (meridiem === "pm" ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function bolnaCurrentIST() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const read = type => parts.find(part => part.type === type)?.value || "";
  return {
    date: `${read("year")}-${read("month")}-${read("day")}`,
    time: `${read("hour")}:${read("minute")}`
  };
}

app.post("/bolna/enquiry", requireBolnaApiKey, async (req, res) => {
  try {
    const input = req.body && typeof req.body === "object" ? req.body : {};

    // Bolna must pass fully RESOLVED travel date and time, in IST.
    // Relative terms (today/tomorrow) are not valid dates here.
    const customerName = bolnaText(input.customerName || input.name, 120);
    const phone = normalizeWhatsAppNumber(
      input.customerPhone || input.phone || input.mobile
    );
    const pickup = bolnaText(input.pickup || input.from, 200);
    const drop = bolnaText(input.drop || input.to, 200);
    const journeyISO = bolnaDateToISO(input.journeyDate || input.pickupDate);
    const journeyTime = bolnaTimeTo24Hour(
      input.journeyTime || input.pickupTime
    );
    const serviceType = bolnaText(
      input.serviceType || "One Way Drop Taxi", 100
    );

    // No tour/round-trip enquiry should be handled as a one-way booking.
    if (!/^(one[ -]?way( drop taxi| taxi)?|drop taxi)$/i.test(serviceType)) {
      return res.status(400).json({
        ok: false,
        error: "This API accepts One Way Drop Taxi enquiries only. Route other services to office staff."
      });
    }

    const validPhone = /^(91\d{10}|\d{10})$/.test(phone);
    if (!customerName || !validPhone || !pickup || !drop || !journeyISO || !journeyTime) {
      return res.status(400).json({
        ok: false,
        error: "Customer name, valid Indian phone, pickup, drop, resolved journeyDate and journeyTime are required"
      });
    }

    const nowIST = bolnaCurrentIST();
    if (journeyISO < nowIST.date ||
        (journeyISO === nowIST.date && journeyTime < nowIST.time)) {
      return res.status(400).json({
        ok: false,
        error: "Pickup date/time has already passed in Asia/Kolkata timezone"
      });
    }

    const journeyDate = journeyISO; // ISO format is parseable by existing Staff/Admin date code.
    const journeyDateDisplay = `${journeyISO.slice(8, 10)}-${journeyISO.slice(5, 7)}-${journeyISO.slice(0, 4)}`;
    const callId = bolnaText(input.callId || input.call_id, 128);

    const passengerCount = Number(input.passengerCount || input.passengers || 0);
    const luggageCount = Number(input.luggageCount || input.bagCount || 0);
    const document = {
      customerName,
      name: customerName,
      customerPhone: phone,
      phone,
      mobile: phone,
      pickup,
      from: pickup,
      drop,
      to: drop,
      pickupAddress: bolnaText(input.pickupAddress, 300),
      dropAddress: bolnaText(input.dropAddress, 300),
      journeyDate,
      journeyDateDisplay,
      journeyTime,
      pickupDateTimeIST: `${journeyISO}T${journeyTime}:00+05:30`,
      passengerCount: Number.isInteger(passengerCount) && passengerCount > 0 && passengerCount <= 100
        ? passengerCount : null,
      luggageCount: Number.isInteger(luggageCount) && luggageCount >= 0 && luggageCount <= 100
        ? luggageCount : null,
      vehiclePreference: bolnaText(input.vehiclePreference || input.vehicle, 160),
      vehicleExactOnly: input.vehicleExactOnly === true,
      details: bolnaText(input.details || input.specialInstructions, 1500),
      serviceType: "One Way Drop Taxi",
      source: "BOLNA_AI",
      sourceChannel: "BOLNA_AI",
      enquirySource: "Bolna AI Call",
      aiEnquiry: true,
      bolnaCallId: callId,
      adminStatus: "New",
      bookingStatus: "Enquiry",
      status: "New Enquiry",
      staffStatus: "New",
      driverStatus: "Not Assigned",
      assignedStaffId: "",
      assignedStaffName: "",
      assignedStaff: "",
      assignedStaffUid: "",
      staffOwnerLocked: false,
      staffAssignmentMethod: "PENDING",
      requiresStaffAssignment: true,
      assignedDriverId: "",
      assignedDriverName: "",
      websiteEnquiry: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    let enquiryRef;
    if (callId) {
      // Repeat tool execution for the same call should not create
      // a second booking enquiry.
      const digest = require("crypto")
        .createHash("sha256")
        .update(callId)
        .digest("hex")
        .slice(0, 36);
      enquiryRef = db.collection("enquiries").doc(`BOLNA_${digest}`);
      try {
        await enquiryRef.create(document);
      } catch (error) {
        if (error.code === 6 || error.code === "already-exists") {
          return res.status(200).json({
            ok: true,
            enquiryId: enquiryRef.id,
            duplicate: true,
            message: "This call enquiry is already recorded. Office staff will follow up."
          });
        }
        throw error;
      }
    } else {
      // Bolna callId is recommended to prevent duplicate enquiries.
      enquiryRef = await db.collection("enquiries").add(document);
    }

    console.log("BOLNA ENQUIRY CREATED:", enquiryRef.id);
    return res.status(201).json({
      ok: true,
      enquiryId: enquiryRef.id,
      staffAssigned: false,
      message: "Enquiry received. Our office team will contact the customer."
    });
  } catch (error) {
    console.error("Bolna enquiry save error:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Unable to save enquiry. Please ask office staff to follow up."
    });
  }
});

// ================= VIBELO BOLNA AUTO ONE-WAY ADD-ON =================
// Additive: Admin secure ON/OFF, verified route quote, customer-confirmed
// one-way duty posting. Existing WhatsApp, billing and /bolna/enquiry preserved.
{
  const bolnaCrypto = require("crypto");
  const BA_SETTINGS = db.collection("settings").doc("bolnaOneWayAutoBooking");
  const baTs = () => admin.firestore.FieldValue.serverTimestamp();
  const baTxt = (v, n = 200) => bolnaText(v, n);
  const baMoney = (v) => Math.round(Number(v) * 100) / 100;
  const baIsOneWay = (v) => /^(one[ -]?way( drop taxi| taxi)?|drop taxi)$/i.test(baTxt(v, 100));

  // Missing setting means OFF. Any Firestore read error means no automatic posting.
  async function baMode() {
    const snap = await BA_SETTINGS.get();
    return snap.exists && snap.data().enabled === true;
  }

  // Matches the separate Admin HTML's Firebase Auth / custom-claim login.
  async function baRequireAdmin(req, res, next) {
    try {
      const m = /^Bearer (\S+)$/i.exec(req.get("Authorization") || "");
      if (!m) {
        return res.status(401).json({ok: false, error: "Firebase Admin sign-in required"});
      }
      const decoded = await admin.auth().verifyIdToken(m[1], true);
      if (decoded.admin !== true && decoded.role !== "admin") {
        return res.status(403).json({ok: false, error: "Verified Firebase Admin custom claim required"});
      }
      req.bolnaAdminUid = decoded.uid;
      return next();
    } catch (e) {
      return res.status(401).json({ok: false, error: "Firebase Admin token invalid or expired"});
    }
  }

  app.get("/admin/bolna-oneway-auto", baRequireAdmin, async (req, res) => {
    try {
      return res.json({ok: true, enabled: await baMode()});
    } catch (e) {
      console.error("Bolna control load:", e.message);
      return res.status(503).json({ok: false, error: "Cannot read Bolna setting"});
    }
  });

  app.post("/admin/bolna-oneway-auto", baRequireAdmin, async (req, res) => {
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ok: false, error: "enabled must be boolean"});
    }
    try {
      const enabled = req.body.enabled;
      const previousEnabled = await baMode();
      const batch = db.batch();
      batch.set(BA_SETTINGS, {
        enabled,
        updatedByUid: req.bolnaAdminUid,
        updatedAt: baTs(),
      }, {merge: true});
      batch.set(db.collection("adminAuditLogs").doc(), {
        action: "BOLNA_ONEWAY_AUTOMATION_CHANGE",
        source: "Admin Firebase Auth",
        actorUid: req.bolnaAdminUid,
        previousEnabled,
        newEnabled: enabled,
        createdAt: baTs(),
      });
      await batch.commit();
      return res.json({ok: true, enabled});
    } catch (e) {
      console.error("Bolna control save:", e.message);
      return res.status(503).json({ok: false, error: "Bolna setting not saved"});
    }
  });

  function baVehicle(value) {
    const t = baTxt(value, 100).toLowerCase().replace(/[\s_-]+/g, " ").trim();
    if (/^(sedan|small car|small sedan|dzire|swift dzire|etios|aura|tigor)$/.test(t)) {
      return {type: "Sedan", rate: 15, seats: 4};
    }
    if (/^(suv|7 seater|seven seater|innova|innova regular|ertiga|carens|kia carens|maruti ertiga)$/.test(t)) {
      return {type: "SUV", rate: 20, seats: 7};
    }
    if (/^(innova crysta|crysta)$/.test(t)) {
      return {type: "Innova Crysta", rate: 25, seats: 7};
    }
    return null; // Unknown model: staff confirmation required.
  }

  function baCallDocId(callId) {
    return "BOLNA_" + bolnaCrypto.createHash("sha256")
      .update(callId).digest("hex").slice(0, 36);
  }

  // Quoted distance comes from Google Routes, not an AI-generated guess.
  // Render must have a valid GOOGLE_MAPS_API_KEY with Routes API access.
  app.post("/bolna/oneway-quote", requireBolnaApiKey, async (req, res) => {
    try {
      const x = req.body || {};
      const callId = baTxt(x.callId || x.call_id, 128);
      const pickupAddress = baTxt(x.pickupAddress, 300);
      const dropAddress = baTxt(x.dropAddress, 300);
      const vehicle = baVehicle(x.vehiclePreference || x.vehicleType || x.vehicle);
      const people = Number(x.passengerCount || x.passengers);
      const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!callId || !pickupAddress || !dropAddress || !vehicle ||
          !Number.isInteger(people) || people < 1 || people > vehicle.seats) {
        return res.status(400).json({
          ok: false,
          error: "callId, full pickup/drop address, supported vehicle and valid passengerCount required; refer to staff",
        });
      }
      if (!mapsKey) {
        return res.status(503).json({ok: false, error: "Route verification unavailable; staff confirmation required"});
      }
      const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": mapsKey,
          "X-Goog-FieldMask": "routes.distanceMeters",
        },
        body: JSON.stringify({
          origin: {address: pickupAddress + ", India"},
          destination: {address: dropAddress + ", India"},
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_UNAWARE",
          computeAlternativeRoutes: false,
        }),
      });
      const body = await response.json();
      const meters = Number(body?.routes?.[0]?.distanceMeters);
      if (!response.ok || !Number.isFinite(meters) || meters <= 0 || meters > 5000000) {
        return res.status(503).json({ok: false, error: "Verified route distance unavailable; staff confirmation required"});
      }

      const km = baMoney(meters / 1000);
      const billableKm = Math.max(120, Math.ceil(km));
      const settings = await db.collection("settings").doc("commissionRules").get();
      const rules = settings.exists ? settings.data() : {};
      const driverBata = Number.isFinite(Number(rules.driverBata)) && Number(rules.driverBata) >= 0
        ? Number(rules.driverBata) : 400;
      const commissionPct = Number.isFinite(Number(rules.oneWayCommissionPct)) && Number(rules.oneWayCommissionPct) >= 0
        ? Number(rules.oneWayCommissionPct) : 10;
      const commissionFixed = Number.isFinite(Number(rules.driverGsc)) && Number(rules.driverGsc) >= 0
        ? Number(rules.driverGsc) : 200;
      const kmFare = baMoney(billableKm * vehicle.rate);
      const quotedFare = baMoney(kmFare + driverBata);
      const commissionTotal = baMoney(kmFare * commissionPct / 100 + commissionFixed);
      const quoteId = bolnaCrypto.randomBytes(16).toString("hex");
      const createdMs = Date.now();
      await db.collection("bolnaOneWayQuotes").doc(quoteId).create({
        callId, pickupAddress, dropAddress,
        vehicleType: vehicle.type, ratePerKM: vehicle.rate,
        passengerCount: people, routeDistanceKm: km, billableKm,
        kmFare, driverBata, quotedFare,
        commissionPct, commissionFixed, commissionTotal,
        createdMs, expiresMs: createdMs + 30 * 60 * 1000,
        source: "GOOGLE_ROUTES_API", createdAt: baTs(),
      });
      return res.status(201).json({
        ok: true, quoteId, vehicleType: vehicle.type,
        routeDistanceKm: km, billableKm, ratePerKM: vehicle.rate,
        kmFare, driverBata, quotedFare, quoteExpiresInMinutes: 30,
        excludedExtras: "Toll, parking, permit and hill charges are extra if applicable.",
      });
    } catch (e) {
      console.error("Bolna quote error:", e.message);
      return res.status(503).json({ok: false, error: "Fare quote unavailable; staff confirmation required"});
    }
  });

  // Only an explicitly accepted verified fare can auto-post when Admin is ON.
  // An enquiry, an ambiguous OK, or an unverified fare stays with Staff.
  app.post("/bolna/confirmed-oneway", requireBolnaApiKey, async (req, res) => {
    try {
      const x = req.body || {};
      if (!baIsOneWay(x.serviceType)) {
        return res.status(400).json({ok: false, error: "Only one-way taxi; refer other services to staff"});
      }
      const callId = baTxt(x.callId || x.call_id, 128);
      const name = baTxt(x.customerName || x.name, 120);
      const phone = normalizeWhatsAppNumber(x.customerPhone || x.phone || x.mobile);
      const pickup = baTxt(x.pickup || x.from, 200);
      const drop = baTxt(x.drop || x.to, 200);
      const date = bolnaDateToISO(x.journeyDate || x.pickupDate);
      const time = bolnaTimeTo24Hour(x.journeyTime || x.pickupTime);
      if (!callId || !name || !/^(91\d{10}|\d{10})$/.test(phone) ||
          !pickup || !drop || !date || !time) {
        return res.status(400).json({
          ok: false, error: "callId, name, valid phone, pickup, drop, exact IST date/time required",
        });
      }
      const now = bolnaCurrentIST();
      if (date < now.date || (date === now.date && time < now.time)) {
        return res.status(400).json({ok: false, error: "Journey date/time already passed in IST"});
      }

      const directEnabled = await baMode();
      const quoteId = baTxt(x.quoteId, 64);
      let quote = null;
      let autoApproved = false;
      let reason = "Staff confirmation mode";
      if (directEnabled) {
        reason = "Customer confirmation or verified quote not complete";
        // Driver V35 validates vehicle CATEGORY, not the exact model. Therefore
        // model-exclusive requests must go to Staff rather than risking mismatch.
        // Driver V35 matches all 7-seater SUV models in one category, so even
        // the Crysta rate must not automatically assign a non-Crysta SUV.
        const requestedVehicle = baVehicle(x.vehiclePreference || x.vehicleType || x.vehicle);
        if (x.vehicleExactOnly === true || requestedVehicle?.type === "Innova Crysta") {
          reason = "Exact/premium vehicle model requires staff to verify the matching driver";
        } else if (x.explicitCustomerConfirmation === true &&
                   x.fareConfirmed === true &&
                   x.acceptedPriceTerms === true && quoteId) {
          const quoteSnap = await db.collection("bolnaOneWayQuotes").doc(quoteId).get();
          if (quoteSnap.exists) {
            const q = quoteSnap.data();
            const acceptedFare = Number(x.acceptedFareAmount);
            const passengerCount = Number(x.passengerCount || x.passengers || 0);
            if (q.callId === callId && Date.now() <= q.expiresMs &&
                Number.isFinite(acceptedFare) &&
                Math.abs(acceptedFare - q.quotedFare) < 0.005 &&
                passengerCount === q.passengerCount &&
                baTxt(x.pickupAddress, 300) === q.pickupAddress &&
                baTxt(x.dropAddress, 300) === q.dropAddress &&
                baVehicle(x.vehiclePreference || x.vehicleType || x.vehicle)?.type === q.vehicleType) {
              autoApproved = true;
              quote = q;
              reason = "";
            } else {
              reason = "Quote mismatch, changed passenger/address/vehicle, or quote expired";
            }
          } else {
            reason = "Quote ID not found";
          }
        }
      }

      const enquiryId = baCallDocId(callId);
      const enquiryRef = db.collection("enquiries").doc(enquiryId);
      const base = {
        customerName: name, name,
        phone, customerPhone: phone, mobile: phone,
        pickup, from: pickup, drop, to: drop,
        journeyDate: date, journeyTime: time,
        pickupDateTimeIST: `${date}T${time}:00+05:30`,
        pickupAddress: baTxt(x.pickupAddress, 300),
        dropAddress: baTxt(x.dropAddress, 300),
        serviceType: "One Way Drop Taxi",
        source: "BOLNA_AI", sourceChannel: "BOLNA_AI",
        enquirySource: "Bolna AI Call", aiEnquiry: true,
        bolnaCallId: callId,
        passengerCount: Number(x.passengerCount || x.passengers) || null,
        details: baTxt(x.details || x.specialInstructions, 1000),
        websiteEnquiry: false,
      };

      const result = await db.runTransaction(async (tx) => {
        const oldSnap = await tx.get(enquiryRef);
        const old = oldSnap.exists ? oldSnap.data() : {};
        // Once accepted, completed, cancelled or assigned, never re-post a duty
        // from a retried Bolna tool call.
        const dutyState = String(old.dutyStatus || "").toLowerCase().trim();
        const reserved = Boolean(
          old.assignedDriverId || old.driverAcceptedAt || old.acceptedAt ||
          ["open", "posted", "accepted", "trip started", "running",
           "completed", "manually assigned", "cancelled", "canceled",
           "driver cancelled", "rejected"].includes(dutyState) ||
          ["confirmed", "cancelled", "canceled", "completed"].includes(String(old.bookingStatus || "").toLowerCase())
        );
        if (reserved) {
          return {
            autoPosted: ["open", "posted"].includes(dutyState),
            alreadyProcessed: true, mode: "existing", enquiryId,
          };
        }
        const staffHasClaim = Boolean(
          old.staffOwnerLocked || old.assignedStaffId || old.assignedStaffUid
        );
        // Transaction re-check ensures an OFF toggle cannot be bypassed by a
        // request that read an earlier ON value.
        const liveModeSnap = await tx.get(BA_SETTINGS);
        const modeStillOn = liveModeSnap.exists && liveModeSnap.data().enabled === true;
        const postNow = autoApproved && modeStillOn && !staffHasClaim;
        const initial = {
          ...base, status: "New Enquiry", bookingStatus: "Enquiry",
          adminStatus: "New", staffStatus: "New", driverStatus: "Not Assigned",
          assignedStaffId: "", assignedStaffName: "", assignedStaffUid: "",
          staffOwnerLocked: false, staffAssignmentMethod: "PENDING",
          requiresStaffAssignment: true, assignedDriverId: "",
          createdAt: baTs(), updatedAt: baTs(),
        };

        if (postNow) {
          // Driver V35 picks up dutyStatus Open from the enquiries collection.
          const posted = {
            ...base,
            status: "Duty Posted", bookingStatus: "Confirmed",
            adminStatus: "Confirmed", staffStatus: "Confirmed",
            aiCustomerConfirmed: true,
            dutyStatus: "Open", driverStatus: "Not Assigned",
            assignedDriverId: "", assignedDriverName: "",
            driverName: "", driverPhone: "", vehicleNumber: "",
            assignedStaffId: "", assignedStaffUid: "",
            staffAssignmentMethod: "AI_AUTO_CONFIRMED",
            requiresStaffAssignment: false, dutySendMode: "all",
            manualAssignment: false,
            vehiclePreference: quote.vehicleType,
            vehicleType: quote.vehicleType,
            ratePerKM: quote.ratePerKM,
            totalKM: quote.billableKm,
            estimatedKM: quote.routeDistanceKm,
            kmFare: quote.kmFare,
            driverFee: quote.driverBata,
            totalFare: quote.quotedFare,
            commissionPct: quote.commissionPct,
            commissionFixed: quote.commissionFixed,
            commissionTotal: quote.commissionTotal,
            lockedCommissionTotal: quote.commissionTotal,
            lockedCommissionPct: quote.commissionPct,
            lockedCommissionFixed: quote.commissionFixed,
            requiredWallet: quote.commissionTotal,
            driverNotificationStatus: "New",
            customerPhoneHiddenBeforeAccept: true,
            fareQuoteId: quoteId,
            autoConfirmedBy: "BOLNA_AI_VERIFIED_QUOTE",
            customerNotificationStatus: "Prepared",
            confirmedAt: baTs(), dutyPostedAt: baTs(), updatedAt: baTs(),
          };
          if (oldSnap.exists) tx.update(enquiryRef, posted);
          else tx.create(enquiryRef, {...initial, ...posted});
          return {autoPosted: true, mode: "auto", enquiryId};
        }

        // Preserve any earlier Staff owner/lock and all Staff edits.
        if (oldSnap.exists) {
          tx.update(enquiryRef, {
            aiConfirmPending: true,
            aiCustomerConfirmed: x.explicitCustomerConfirmation === true,
            updatedAt: baTs(),
          });
        } else {
          tx.create(enquiryRef, initial);
        }
        return {
          autoPosted: false, mode: "staff", enquiryId,
          reason: staffHasClaim ? "Already owned by Staff" :
            !modeStillOn ? "Admin setting OFF" : reason,
        };
      });
      return res.status(result.alreadyProcessed ? 200 : 201).json({
        ok: true, ...result,
        message: result.mode === "staff"
          ? "One-way enquiry kept for Staff confirmation; NOT sent to drivers."
          : result.mode === "auto"
            ? "Confirmed one-way booking posted to Driver Available Duties; Staff/Admin may monitor."
            : "An earlier booking or duty already exists. No new posting made.",
      });
    } catch (e) {
      console.error("Bolna one-way auto confirmation:", e.message);
      return res.status(503).json({
        ok: false,
        error: "Booking update failed; ask office staff to confirm before publishing duty",
      });
    }
  });
}
// ================= END VIBELO BOLNA AUTO ADD-ON =================


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
