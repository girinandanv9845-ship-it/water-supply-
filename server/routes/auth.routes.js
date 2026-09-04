'use strict';

const express = require('express');
const ctrl = require('../controllers/auth.controller');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { otpRequestLimiter, otpVerifyLimiter, adminLoginLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.post(
  '/otp/request',
  otpRequestLimiter,
  validate({ body: z.object({ phone: fields.phone }) }),
  ctrl.requestOtp
);

router.post(
  '/otp/verify',
  otpVerifyLimiter,
  validate({
    body: z.object({
      phone: fields.phone,
      code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.'),
      name: fields.trimmed(80).min(2).optional(),
    }),
  }),
  ctrl.verifyOtp
);

router.post(
  '/admin/login',
  adminLoginLimiter,
  validate({
    body: z.object({
      phone: fields.phone,
      password: z.string().min(8).max(200),
    }),
  }),
  ctrl.adminLogin
);

router.get('/me', requireAuth, ctrl.me);
router.post('/logout', requireAuth, ctrl.logout);

router.patch(
  '/me',
  requireAuth,
  validate({
    body: z.object({
      name: fields.trimmed(80).min(2),
      email: z.string().trim().email().optional().or(z.literal('')),
    }),
  }),
  ctrl.updateProfile
);

module.exports = router;
