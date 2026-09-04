'use strict';

const rateLimit = require('express-rate-limit');
const { env } = require('../config/env');

const shared = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again shortly.' },
    }),
};

/** Broad guard on the whole API surface. */
const apiLimiter = rateLimit({ ...shared, windowMs: 60 * 1000, max: 300 });

/** OTP request is the most abusable endpoint - keyed by phone, not just IP. */
const otpRequestLimiter = rateLimit({
  ...shared,
  windowMs: 10 * 60 * 1000,
  max: env.DEMO_MODE ? 50 : 5,
  keyGenerator: (req) => `${req.ip}:${(req.body && req.body.phone) || 'unknown'}`,
});

const otpVerifyLimiter = rateLimit({
  ...shared,
  windowMs: 10 * 60 * 1000,
  max: env.DEMO_MODE ? 100 : 10,
  keyGenerator: (req) => `${req.ip}:${(req.body && req.body.phone) || 'unknown'}`,
});

const adminLoginLimiter = rateLimit({ ...shared, windowMs: 15 * 60 * 1000, max: 10 });

/** Payment endpoints - protects against replay storms and Razorpay quota burn. */
const paymentLimiter = rateLimit({ ...shared, windowMs: 60 * 1000, max: 20 });

/** AI calls cost money per request. */
const chatLimiter = rateLimit({ ...shared, windowMs: 60 * 1000, max: 20 });

/** Driver GPS pings. Generous because the client throttles to ~1 per 5s. */
const locationLimiter = rateLimit({ ...shared, windowMs: 60 * 1000, max: 120 });

module.exports = {
  apiLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  adminLoginLimiter,
  paymentLimiter,
  chatLimiter,
  locationLimiter,
};
