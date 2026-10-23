"use strict";

// VIBELO SMS OTP + Firebase Welcome & Referral Rewards
// SMS ONLY - NO VOICE OTP
// Node.js 18+, express, firebase-admin required

const express = require("express");
const crypto = require("crypto");
const admin = require("firebase-admin");

const router = express.Router();

const sessions = new Map();
const limits = new Map();

const OTP_LIFETIME = 5 * 60 * 1000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// =======================================
// VALIDATE MOBILE NUMBER
// =======================================

function validPhone(value) {
  const phone = String(value || "")
    .replace(/[\s-]/g, "")
    .replace(/^\+91/, "")
    .replace(/^91(?=\d{10}$)/, "");

  return /^[6-9]\d{9}$/.test(phone)
    ? phone
    : null;
}

// =======================================
// RATE LIMIT
// =======================================

function allowed(key, maximum, windowMs) {
  const now = Date.now();
  const current = limits.get(key);

  if (!current || now >= current.until) {
    limits.set(key, {
      count: 1,
      until: now + windowMs
    });
    return true;
  }

  if (current.count >= maximum) {
    return false;
  }

  current.count += 1;
  return true;
}

// =======================================
// CLEAN EXPIRED SESSIONS
// =======================================

function cleanup() {
  const now = Date.now();

  for (const [key, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(key);
    }
  }

  for (const [key, limit] of limits) {
    if (limit.until <= now) {
      limits.delete(key);
    }
  }
}

// =======================================
// PROVIDER ERROR DETAILS
// =======================================

function providerDetails(result) {
  return String(
    result?.Details ||
    result?.message ||
    "No reason supplied"
  ).slice(0, 200);
}

// =======================================
// 2FACTOR SMS API
// =======================================

async function factorRequest(path) {
  const key = String(
    process.env.TWOFACTOR_API_KEY || ""
  ).trim();

  if (!key) {
    throw new Error(
      "2Factor API key not configured"
    );
  }

  const url =
    `https://2factor.in/API/V1/` +
    `${encodeURIComponent(key)}${path}`;

  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(15000)
  });

  const body = await response.text();

  let result;

  try {
    result = JSON.parse(body);
  } catch {
    console.error(
      "2Factor returned non-JSON response. HTTP:",
      response.status
    );

    throw new Error(
      "Invalid 2Factor response"
    );
  }

  if (!response.ok) {
    console.error(
      "2Factor HTTP:",
      response.status
    );

    console.error(
      "2Factor reason:",
      providerDetails(result)
    );

    throw new Error(
      `2Factor HTTP ${response.status}`
    );
  }

  return result;
}

// =======================================
// BONUS AMOUNT
// =======================================

function bonusAmount(value, fallback) {
  if (
    value === undefined ||
    value === null
  ) {
    return fallback;
  }

  const number = Number(value);

  return Number.isFinite(number) &&
    number >= 0 &&
    number <= 10000
    ? Math.round(number * 100) / 100
    : fallback;
}

// =======================================
// FIREBASE CUSTOMER REGISTRATION
// =======================================

async function registerOnce(record) {
  const db = admin.firestore();

  const uid = `customer_91${record.phone}`;
  const mobile = record.phone;

  const customerRef = db
    .collection("customers")
    .doc(uid);

  const rewardsRef = db
    .collection("settings")
    .doc("customerRewards");

  const code =
    "VIB" +
    crypto.randomBytes(8)
      .toString("hex")
      .toUpperCase();

  const codeRef = db
    .collection("referralCodes")
    .doc(code);

  const enteredRef = record.referralCode
    ? db.collection("referralCodes")
        .doc(record.referralCode)
    : null;

  return db.runTransaction(async (tx) => {

    const customerSnap =
      await tx.get(customerRef);

    // Existing customer - No repeat bonus

    if (customerSnap.exists) {
      const existing =
        customerSnap.data() || {};

      return {
        customer: {
          name: existing.name || record.name,
          mobile,
          referralCode:
            existing.referralCode || "",
          referralCount:
            existing.referralCount || 0,
          wallet: existing.wallet || {
            welcome: 0,
            referral: 0,
            cashback: 0
          }
        },

        firstRegistration: false,
        welcomeCreditedNow: 0,
        referralCreditedNow: 0
      };
    }

    // Read all documents before writing

    const rewardsSnap =
      await tx.get(rewardsRef);

    const newCodeSnap =
      await tx.get(codeRef);

    const enteredSnap = enteredRef
      ? await tx.get(enteredRef)
      : null;

    const referrerUid = enteredSnap?.exists
      ? enteredSnap.data()?.customerUid
      : null;

    const referrerRef =
      referrerUid && referrerUid !== uid
        ? db.collection("customers")
            .doc(referrerUid)
        : null;

    const referrerSnap = referrerRef
      ? await tx.get(referrerRef)
      : null;

    if (newCodeSnap.exists) {
      throw new Error(
        "Referral code collision; retry registration"
      );
    }

    const config = rewardsSnap.exists
      ? rewardsSnap.data() || {}
      : {};

    // Welcome Bonus - Default Rs.100

    const welcome =
      config.enabled === false
        ? 0
        : bonusAmount(
            config.welcomeBonus,
            100
          );

    // Referral Bonus - Default Rs.25

    const referralBonus =
      config.enabled === false ||
      config.referralEnabled === false
        ? 0
        : bonusAmount(
            config.referralBonus,
            25
          );

    const validReferrer = Boolean(
      referrerSnap?.exists &&
      referrerSnap.data()?.phoneVerified === true
    );

    const creditedToReferrer =
      validReferrer ? referralBonus : 0;

    const now =
      admin.firestore.FieldValue
        .serverTimestamp();

    const customer = {
      uid,
      name: record.name,
      mobile,
      phoneE164: `+91${mobile}`,
      phoneVerified: true,
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,

      referralCode: code,

      referredBy: validReferrer
        ? referrerUid
        : null,

      referralCount: 0,

      wallet: {
        welcome,
        referral: 0,
        cashback: 0
      },

      walletBalance: welcome,

      welcomeBonusCredited: welcome > 0,
      welcomeBonusAmount: welcome
    };

    // Create new customer

    tx.create(customerRef, customer);

    // Save customer's unique referral code

    tx.create(codeRef, {
      customerUid: uid,
      createdAt: now
    });

    // Rs.100 Welcome Bonus - Only Once

    if (welcome > 0) {
      tx.create(
        db.collection("walletTransactions")
          .doc(`welcome_${uid}`),
        {
          customerUid: uid,
          amount: welcome,
          type: "WELCOME_BONUS",
          newCustomerUid: uid,
          createdAt: now
        }
      );
    }

    // Rs.25 Referral Reward - Referrer Only

    if (
      validReferrer &&
      creditedToReferrer > 0
    ) {
      tx.update(referrerRef, {
        "wallet.referral":
          admin.firestore.FieldValue
            .increment(creditedToReferrer),

        walletBalance:
          admin.firestore.FieldValue
            .increment(creditedToReferrer),

        referralCount:
          admin.firestore.FieldValue
            .increment(1),

        updatedAt: now
      });

      tx.create(
        db.collection("walletTransactions")
          .doc(`referral_${uid}`),
        {
          customerUid: referrerUid,
          newCustomerUid: uid,
          amount: creditedToReferrer,
          type: "REFERRAL_BONUS",
          createdAt: now
        }
      );

    } else if (validReferrer) {

      tx.update(referrerRef, {
        referralCount:
          admin.firestore.FieldValue
            .increment(1),

        updatedAt: now
      });
    }

    return {
      customer: {
        name: customer.name,
        mobile,
        referralCode: code,
        referralCount: 0,
        wallet: customer.wallet
      },

      firstRegistration: true,
      welcomeCreditedNow: welcome,
      referralCreditedNow:
        creditedToReferrer,
      referralApplied: validReferrer
    };
  });
}

// =======================================
// SEND SMS OTP
// =======================================

router.post("/send", async (req, res) => {

  const phone = validPhone(
    req.body?.phone ||
    req.body?.mobile
  );

  const name = String(
    req.body?.name || "Customer"
  ).trim().slice(0, 80);

  const referralCode = String(
    req.body?.referralCode || ""
  ).trim().toUpperCase().slice(0, 40);

  const template = String(
    process.env.TWOFACTOR_SMS_TEMPLATE ||
    "VIBELO_LOGIN_OTP"
  ).trim();

  if (!phone) {
    return res.status(400).json({
      success: false,
      message: "Invalid mobile number"
    });
  }

  if (!process.env.TWOFACTOR_API_KEY) {
    return res.status(503).json({
      success: false,
      message: "SMS service not configured"
    });
  }

  if (!/^[A-Za-z0-9_-]+$/.test(template)) {
    return res.status(503).json({
      success: false,
      message:
        "SMS template is not configured correctly"
    });
  }

  if (
    referralCode &&
    !/^[A-Z0-9]+$/.test(referralCode)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid referral code format"
    });
  }

  cleanup();

  // Prevent repeated OTP requests

  if (
    !allowed(`phone:${phone}`, 5, HOUR) ||
    !allowed(`ip:${req.ip}`, 20, HOUR) ||
    !allowed(`wait:${phone}`, 1, MINUTE)
  ) {
    return res.status(429).json({
      success: false,
      message:
        "Please wait before requesting another OTP"
    });
  }

  try {

    // SMS OTP ONLY
    // No Voice OTP API is called here

    const result = await factorRequest(
      `/SMS/+91${phone}/AUTOGEN/` +
      encodeURIComponent(template)
    );

    if (
      result.Status !== "Success" ||
      typeof result.Details !== "string" ||
      !result.Details.trim()
    ) {
      console.error(
        "2Factor SMS rejected:",
        providerDetails(result)
      );

      throw new Error(
        "Provider rejected SMS OTP request"
      );
    }

    // Remove old OTP sessions for this number

    for (const [id, session] of sessions) {
      if (session.phone === phone) {
        sessions.delete(id);
      }
    }

    const requestId = crypto.randomUUID();

    sessions.set(requestId, {
      phone,
      name: name || "Customer",
      referralCode,

      providerSessionId: result.Details,

      expiresAt:
        Date.now() + OTP_LIFETIME,

      attempts: 0,
      providerVerified: false,
      processing: false
    });

    return res.json({
      success: true,
      requestId,
      message: "SMS OTP requested"
    });

  } catch (error) {

    console.error(
      "SMS send failed:",
      error.message
    );

    return res.status(502).json({
      success: false,
      message:
        "SMS OTP unavailable. Check 2Factor logs, template and account."
    });
  }
});

// =======================================
// VERIFY SMS OTP
// =======================================

router.post("/verify", async (req, res) => {

  const requestId = String(
    req.body?.requestId || ""
  );

  const otp = String(
    req.body?.otp || ""
  );

  const record = sessions.get(requestId);

  if (
    !record ||
    Date.now() > record.expiresAt
  ) {
    sessions.delete(requestId);

    return res.status(400).json({
      verified: false,
      message:
        "OTP session expired or invalid"
    });
  }

  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({
      verified: false,
      message: "Enter a valid 6-digit OTP"
    });
  }

  if (
    record.attempts >= 5 &&
    !record.providerVerified
  ) {
    sessions.delete(requestId);

    return res.status(429).json({
      verified: false,
      message: "Too many attempts"
    });
  }

  if (record.processing) {
    return res.status(429).json({
      verified: false,
      message:
        "Verification in progress"
    });
  }

  record.processing = true;

  try {

    if (!record.providerVerified) {

      record.attempts++;

      const result = await factorRequest(
        `/SMS/VERIFY/` +
        encodeURIComponent(
          record.providerSessionId
        ) +
        `/` +
        encodeURIComponent(otp)
      );

      if (
        result.Status !== "Success" ||
        result.Details !== "OTP Matched"
      ) {
        return res.status(400).json({
          verified: false,
          message:
            "Incorrect or expired OTP"
        });
      }

      record.providerVerified = true;
    }

    // Register customer after OTP verification

    const registered =
      await registerOnce(record);

    // Firebase Custom Token

    const firebaseCustomToken =
      await admin.auth().createCustomToken(
        `customer_91${record.phone}`
      );

    sessions.delete(requestId);

    return res.json({
      verified: true,
      ...registered,
      firebaseCustomToken,

      message:
        registered.firstRegistration
          ? "Registration complete"
          : "Welcome back"
    });

  } catch (error) {

    console.error(
      "SMS verify / Firebase registration failed:",
      error.message
    );

    return res.status(502).json({
      verified: false,
      message:
        "Verification or registration temporarily unavailable"
    });

  } finally {

    record.processing = false;

  }
});

// =======================================
// EXPORT ROUTER
// =======================================

module.exports = router;
