"use strict";

const express = require("express");
const router = express.Router();

// VIBELO CUSTOMER VOICE OTP
// Mobile validation + safe OTP placeholder

// STEP 1: REQUEST VOICE OTP

router.post("/request", (req, res) => {
  const mobile = String(req.body?.mobile || "").trim();

  if (!/^[6-9]\d{9}$/.test(mobile)) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid 10-digit Indian mobile number."
    });
  }

  return res.status(503).json({
    success: false,
    message: "Voice OTP service not activated yet."
  });
});

// STEP 2: VERIFY VOICE OTP

router.post("/verify", (req, res) => {
  return res.status(503).json({
    success: false,
    verified: false,
    message: "OTP verification not available yet."
  });
});

module.exports = router;