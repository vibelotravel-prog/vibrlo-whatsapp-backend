"use strict";

const express = require("express");
const router = express.Router();

// VIBELO Voice OTP Backend
// Provider activation is pending.
// Never verify a customer without a real OTP check.

router.post("/request", (req, res) => {
  return res.status(503).json({
    success: false,
    message: "Voice OTP service not activated yet."
  });
});

router.post("/verify", (req, res) => {
  return res.status(503).json({
    success: false,
    verified: false,
    message: "OTP verification not available yet."
  });
});

module.exports = router;