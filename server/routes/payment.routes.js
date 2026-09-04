'use strict';

const express = require('express');
const { ok, asyncHandler } = require('../utils/apiResponse');
const { requireAuth } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { paymentLimiter } = require('../middleware/rateLimit');
const paymentService = require('../services/payment.service');

const router = express.Router();

/**
 * POST /api/payments/create
 * Body carries ONLY the order id. The amount is derived server-side.
 */
router.post(
  '/create',
  requireAuth,
  paymentLimiter,
  validate({ body: z.object({ orderId: fields.cuid }) }),
  asyncHandler(async (req, res) => {
    const intent = await paymentService.createPaymentForOrder(req.body.orderId, req.user);
    return ok(res, intent);
  })
);

/** POST /api/payments/verify - server-side signature verification. */
router.post(
  '/verify',
  requireAuth,
  paymentLimiter,
  validate({
    body: z.object({
      providerOrderId: z.string().trim().min(1).max(120),
      providerPaymentId: z.string().trim().min(1).max(120).optional(),
      signature: z.string().trim().min(1).max(256).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await paymentService.verifyPayment(req.body, req.user);
    return ok(res, result);
  })
);

/** POST /api/payments/failed - customer closed/abandoned the checkout. */
router.post(
  '/failed',
  requireAuth,
  paymentLimiter,
  validate({
    body: z.object({
      providerOrderId: z.string().trim().min(1).max(120),
      reason: fields.trimmed(300).optional().or(z.literal('')),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await paymentService.markPaymentFailed(req.body, req.user);
    return ok(res, result);
  })
);

/**
 * POST /api/payments/webhook
 * Razorpay -> us. Uses the raw body captured in app.js for HMAC verification,
 * and is deliberately NOT behind requireAuth.
 */
router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const result = await paymentService.handleWebhook(req.rawBody, req.headers['x-razorpay-signature']);
    return ok(res, result);
  })
);

module.exports = router;
