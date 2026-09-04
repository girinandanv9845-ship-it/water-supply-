'use strict';

const express = require('express');
const ctrl = require('../controllers/order.controller');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { STATUS } = require('../utils/orderStateMachine');

const router = express.Router();
router.use(requireAuth);

const idParam = z.object({ id: fields.cuid });

router.post(
  '/',
  requireRole('CUSTOMER', 'ADMIN'),
  validate({
    body: z.object({
      productId: fields.cuid,
      addressId: fields.cuid,
      quantity: z.coerce.number().int().min(1).max(10).default(1),
      notes: fields.trimmed(500).optional().or(z.literal('')),
      paymentMethod: z.enum(['ONLINE', 'CASH_ON_DELIVERY']).default('ONLINE'),
      scheduledFor: z.string().datetime().optional(),
    }),
  }),
  ctrl.create
);

router.get(
  '/',
  validate({
    query: fields.pagination.extend({
      status: z.enum(Object.keys(STATUS)).optional(),
    }),
  }),
  ctrl.list
);

router.get('/active', ctrl.active);

router.get('/:id', validate({ params: idParam }), ctrl.getOne);
router.get('/:id/track', validate({ params: idParam }), ctrl.track);

router.post(
  '/:id/cancel',
  validate({
    params: idParam,
    body: z.object({ reason: fields.trimmed(300).optional().or(z.literal('')) }),
  }),
  ctrl.cancel
);

module.exports = router;
