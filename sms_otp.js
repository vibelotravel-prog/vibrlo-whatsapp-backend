"use strict";

// VIBELO SMS OTP + one-time Firebase welcome/referral rewards.
// Mount is already present in server.js: app.use('/api/sms-otp', require('./sms_otp'));
// Needs Node 18+, express, firebase-admin initialized by server.js, TWOFACTOR_API_KEY.

const express = require("express");
const crypto = require("crypto");
const admin = require("firebase-admin");

const router = express.Router();
const sessions = new Map();
const limits = new Map();
const OTP_LIFETIME = 5 * 60 * 1000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function validPhone(value) {
  const phone = String(value || "")
    .replace(/[\s-]/g, "")
    .replace(/^\+91/, "")
    .replace(/^91(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(phone) ? phone : null;
}

function allowed(key, maximum, windowMs) {
  const now = Date.now();
  const current = limits.get(key);
  if (!current || now >= current.until) {
    limits.set(key, { count: 1, until: now + windowMs });
    return true;
  }
  if (current.count >= maximum) return false;
  current.count += 1;
  return true;
}

function cleanup() {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(key);
  }
  for (const [key, limit] of limits) {
    if (limit.until < now) limits.delete(key);
  }
}

async function factorRequest(path) {
  const key = process.env.TWOFACTOR_API_KEY;
  if (!key) throw new Error("SMS provider not configured");
  const url = `https://2factor.in/API/V1/${encodeURIComponent(key)}${path}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error("SMS provider unavailable");
  return response.json();
}

function bonusAmount(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 10000
    ? Math.round(n * 100) / 100 : fallback;
}

async function registerOnce(record) {
  // Firestore transactions prevent double credits, even if OTP sessions race.
  const db = admin.firestore();
  const uid = `customer_91${record.phone}`;
  const mobile = record.phone;
  const customerRef = db.collection("customers").doc(uid);
  const rewardsRef = db.collection("settings").doc("customerRewards");
  const code = "VIB" + crypto.randomBytes(8).toString("hex").toUpperCase();
  const codeRef = db.collection("referralCodes").doc(code);
  const enteredCode = record.referralCode;
  const enteredRef = enteredCode
    ? db.collection("referralCodes").doc(enteredCode)
    : null;

  return db.runTransaction(async (tx) => {
    // Firestore requires transaction reads to happen before any writes.
    const customerSnap = await tx.get(customerRef);
    if (customerSnap.exists) {
      const existing = customerSnap.data() || {};
      return {
        customer: {
          name: existing.name || record.name,
          mobile,
          referralCode: existing.referralCode || "",
          referralCount: existing.referralCount || 0,
          wallet: existing.wallet || { welcome: 0, referral: 0, cashback: 0 }
        },
        firstRegistration: false,
        welcomeCreditedNow: 0,
        referralCreditedNow: 0
      };
    }

    const rewardsSnap = await tx.get(rewardsRef);
    const newCodeSnap = await tx.get(codeRef);
    const enteredSnap = enteredRef ? await tx.get(enteredRef) : null;
    const referrerUid = enteredSnap?.exists ? enteredSnap.data()?.customerUid : null;
    const referrerRef = referrerUid && referrerUid !== uid
      ? db.collection("customers").doc(referrerUid) : null;
    const referrerSnap = referrerRef ? await tx.get(referrerRef) : null;

    if (newCodeSnap.exists) throw new Error("Referral code collision; retry registration");
    const config = rewardsSnap.exists ? rewardsSnap.data() || {} : {};
    const welcome = config.enabled === false
      ? 0 : bonusAmount(config.welcomeBonus, 100);
    const referralBonus = config.enabled === false || config.referralEnabled === false
      ? 0 : bonusAmount(config.referralBonus, 25);
    const validReferrer = Boolean(referrerSnap?.exists &&
      referrerSnap.data()?.phoneVerified === true);
    const creditedToReferrer = validReferrer ? referralBonus : 0;
    const now = admin.firestore.FieldValue.serverTimestamp();

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
      referredBy: validReferrer ? referrerUid : null,
      referralCount: 0,
      wallet: { welcome, referral: 0, cashback: 0 },
      walletBalance: welcome,
      welcomeBonusCredited: welcome > 0,
      welcomeBonusAmount: welcome
    };

    tx.create(customerRef, customer);
    tx.create(codeRef, { customerUid: uid, createdAt: now });

    if (welcome > 0) {
      tx.create(db.collection("walletTransactions").doc(`welcome_${uid}`), {
        customerUid: uid,
        amount: welcome,
        type: "WELCOME_BONUS",
        newCustomerUid: uid,
        createdAt: now
      });
    }

    if (validReferrer && creditedToReferrer > 0) {
      tx.update(referrerRef, {
        "wallet.referral": admin.firestore.FieldValue.increment(creditedToReferrer),
        walletBalance: admin.firestore.FieldValue.increment(creditedToReferrer),
        referralCount: admin.firestore.FieldValue.increment(1),
        updatedAt: now
      });
      tx.create(db.collection("walletTransactions").doc(`referral_${uid}`), {
        customerUid: referrerUid,
        newCustomerUid: uid,
        amount: creditedToReferrer,
        type: "REFERRAL_BONUS",
        createdAt: now
      });
    } else if (validReferrer) {
      // Even when Admin sets referral credit to zero, count successful referrals.
      tx.update(referrerRef, {
        referralCount: admin.firestore.FieldValue.increment(1),
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
      referralCreditedNow: creditedToReferrer,
      referralApplied: validReferrer
    };
  });
}

router.post("/send", async (req, res) => {
  const phone = validPhone(req.body?.phone || req.body?.mobile);
  const name = String(req.body?.name || "Customer").trim().slice(0, 80);
  const referralCode = String(req.body?.referralCode || "")
    .trim().toUpperCase().slice(0, 40);

  if (!phone) return res.status(400).json({ success: false, message: "Invalid mobile number" });
  if (!process.env.TWOFACTOR_API_KEY) {
    return res.status(503).json({ success: false, message: "SMS service not configured" });
  }
  if (referralCode && !/^[A-Z0-9]+$/.test(referralCode)) {
    return res.status(400).json({ success: false, message: "Invalid referral code format" });
  }

  cleanup();
  if (!allowed(`phone:${phone}`, 5, HOUR) ||
      !allowed(`ip:${req.ip}`, 20, HOUR) ||
      !allowed(`wait:${phone}`, 1, MINUTE)) {
    return res.status(429).json({ success: false, message: "Please wait before requesting another OTP" });
  }

  try {
    const result = await factorRequest(`/SMS/${phone}/AUTOGEN`);
    if (result.Status !== "Success" || typeof result.Details !== "string") {
      throw new Error("Provider rejected OTP request");
    }
    const requestId = crypto.randomUUID();
    sessions.set(requestId, {
      phone, name: name || "Customer", referralCode,
      providerSessionId: result.Details,
      expiresAt: Date.now() + OTP_LIFETIME,
      attempts: 0,
      providerVerified: false
    });
    return res.json({ success: true, requestId, message: "OTP requested" });
  } catch (error) {
    console.error("SMS send failed:", error.message);
    return res.status(502).json({ success: false, message: "Unable to send OTP. Check 2Factor account and credits." });
  }
});

router.post("/verify", async (req, res) => {
  const requestId = String(req.body?.requestId || "");
  const otp = String(req.body?.otp || "");
  const record = sessions.get(requestId);

  if (!record || Date.now() > record.expiresAt) {
    sessions.delete(requestId);
    return res.status(400).json({ verified: false, message: "OTP session expired or invalid" });
  }
  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ verified: false, message: "Enter a valid 6-digit OTP" });
  }
  if (record.attempts >= 5 && !record.providerVerified) {
    sessions.delete(requestId);
    return res.status(429).json({ verified: false, message: "Too many attempts" });
  }
  if (record.processing) {
    return res.status(429).json({ verified: false, message: "Verification in progress" });
  }
  record.processing = true;
  try {
    if (!record.providerVerified) {
      record.attempts++;
      const result = await factorRequest(
        `/SMS/VERIFY/${encodeURIComponent(record.providerSessionId)}/${encodeURIComponent(otp)}`
      );
      if (result.Status !== "Success" || result.Details !== "OTP Matched") {
        return res.status(400).json({ verified: false, message: "Incorrect OTP" });
      }
      record.providerVerified = true;
    }

    const registered = await registerOnce(record);
    // Firebase custom tokens must be EXCHANGED client-side for a Firebase ID token.
    const firebaseCustomToken = await admin.auth().createCustomToken(`customer_91${record.phone}`);
    sessions.delete(requestId);
    return res.json({
      verified: true,
      ...registered,
      firebaseCustomToken,
      message: registered.firstRegistration ? "Registration complete" : "Welcome back"
    });
  } catch (error) {
    console.error("SMS verify / Firebase registration failed:", error.message);
    return res.status(502).json({ verified: false, message: "Verification or registration temporarily unavailable" });
  } finally {
    record.processing = false;
  }
});

module.exports = router;
