'use strict';

const express = require('express');
const ctrl = require('../controllers/driver.controller');
const { requireAuth, requireDriverProfile } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { locationLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Every driver route requires an authenticated, verified driver.
router.use(requireAuth, requireDriverProfile);

router.get('/me', ctrl.profile);

router.get(
  '/orders',
  validate({ query: z.object({ scope: z.enum(['active', 'history', 'all']).default('active') }) }),
  ctrl.listOrders
);

router.post(
  '/orders/:id/status',
  validate({
    params: z.object({ id: fields.cuid }),
    body: z.object({
      status: z.enum(['DRIVER_ACCEPTED', 'CONFIRMED', 'OUT_FOR_DELIVERY', 'ARRIVING', 'DELIVERED', 'FAILED']),
      note: fields.trimmed(300).optional().or(z.literal('')),
    }),
  }),
  ctrl.updateStatus
);

router.post(
  '/location',
  locationLimiter,
  validate({
    body: z.object({
      latitude: fields.latitude,
      longitude: fields.longitude,
      heading: z.coerce.number().min(0).max(360).optional(),
    }),
  }),
  ctrl.updateLocation
);

router.post(
  '/availability',
  validate({ body: z.object({ available: z.boolean() }) }),
  ctrl.setAvailability
);

module.exports = router;
