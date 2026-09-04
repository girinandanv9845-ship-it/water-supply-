'use strict';

const express = require('express');
const ctrl = require('../controllers/admin.controller');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { STATUS } = require('../utils/orderStateMachine');

const router = express.Router();

// Blanket gate: nothing under /api/admin is reachable without an ADMIN session.
router.use(requireAuth, requireRole('ADMIN'));

const idParam = z.object({ id: fields.cuid });
const searchQuery = fields.pagination.extend({ search: fields.trimmed(80).optional() });

/* ---------- dashboard ---------- */
router.get('/stats', ctrl.stats);
router.get('/live', ctrl.liveMap);

/* ---------- orders ---------- */
router.get(
  '/orders',
  validate({ query: searchQuery.extend({ status: z.enum(Object.keys(STATUS)).optional() }) }),
  ctrl.listOrders
);
router.get('/orders/:id', validate({ params: idParam }), ctrl.getOrder);

router.post(
  '/orders/:id/assign-driver',
  validate({
    params: idParam,
    body: z.object({ driverId: fields.cuid, vehicleId: fields.cuid.optional() }),
  }),
  ctrl.assignDriver
);

router.post(
  '/orders/:id/status',
  validate({
    params: idParam,
    body: z.object({
      status: z.enum(Object.keys(STATUS)),
      note: fields.trimmed(300).optional().or(z.literal('')),
    }),
  }),
  ctrl.updateOrderStatus
);

/* ---------- drivers ---------- */
router.get('/drivers', ctrl.listDrivers);

router.post(
  '/drivers',
  validate({
    body: z.object({
      name: fields.trimmed(80).min(2),
      phone: fields.phone,
      email: z.string().trim().email().optional().or(z.literal('')),
      licenseNumber: fields.trimmed(40).optional().or(z.literal('')),
      isVerified: z.boolean().optional(),
    }),
  }),
  ctrl.createDriver
);

router.patch(
  '/drivers/:id',
  validate({
    params: idParam,
    body: z.object({
      isVerified: z.boolean().optional(),
      status: z.enum(['OFFLINE', 'AVAILABLE', 'ON_DELIVERY', 'SUSPENDED']).optional(),
      licenseNumber: fields.trimmed(40).optional().or(z.literal('')),
      isActive: z.boolean().optional(),
    }),
  }),
  ctrl.updateDriver
);

/* ---------- vehicles ---------- */
router.get('/vehicles', ctrl.listVehicles);

router.post(
  '/vehicles',
  validate({
    body: z.object({
      registrationNumber: fields.trimmed(20).min(4).transform((v) => v.toUpperCase()),
      vehicleType: fields.trimmed(30).default('TANKER'),
      capacityL: z.coerce.number().int().min(100).max(100000),
      status: z.enum(['ACTIVE', 'IN_MAINTENANCE', 'INACTIVE']).default('ACTIVE'),
      driverId: fields.cuid.optional().nullable(),
    }),
  }),
  ctrl.createVehicle
);

router.patch(
  '/vehicles/:id',
  validate({
    params: idParam,
    body: z.object({
      vehicleType: fields.trimmed(30).optional(),
      capacityL: z.coerce.number().int().min(100).max(100000).optional(),
      status: z.enum(['ACTIVE', 'IN_MAINTENANCE', 'INACTIVE']).optional(),
      driverId: fields.cuid.nullable().optional(),
    }),
  }),
  ctrl.updateVehicle
);

/* ---------- products / pricing ---------- */
router.get('/products', ctrl.listProducts);

router.post(
  '/products',
  validate({
    body: z.object({
      name: fields.trimmed(60).min(2),
      slug: fields.trimmed(60).regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and dashes.'),
      description: fields.trimmed(300).optional().or(z.literal('')),
      capacityL: z.coerce.number().int().min(100).max(100000),
      priceRupees: z.coerce.number().min(1).max(1000000),
      vehicleType: fields.trimmed(30).default('TANKER'),
      isActive: z.boolean().default(true),
      sortOrder: z.coerce.number().int().default(0),
      imageEmoji: fields.trimmed(8).optional(),
    }),
  }),
  ctrl.createProduct
);

router.patch(
  '/products/:id',
  validate({
    params: idParam,
    body: z.object({
      name: fields.trimmed(60).min(2).optional(),
      description: fields.trimmed(300).optional().or(z.literal('')),
      capacityL: z.coerce.number().int().min(100).max(100000).optional(),
      priceRupees: z.coerce.number().min(1).max(1000000).optional(),
      vehicleType: fields.trimmed(30).optional(),
      isActive: z.boolean().optional(),
      sortOrder: z.coerce.number().int().optional(),
      imageEmoji: fields.trimmed(8).optional(),
    }),
  }),
  ctrl.updateProduct
);

/* ---------- customers ---------- */
router.get('/customers', validate({ query: searchQuery }), ctrl.listCustomers);
router.patch(
  '/customers/:id',
  validate({ params: idParam, body: z.object({ isActive: z.boolean() }) }),
  ctrl.updateCustomer
);

/* ---------- payments ---------- */
router.get(
  '/payments',
  validate({
    query: fields.pagination.extend({
      status: z.enum(['PENDING', 'CREATED', 'PAID', 'FAILED', 'REFUNDED']).optional(),
    }),
  }),
  ctrl.listPayments
);

/* ---------- service areas ---------- */
const serviceAreaBody = z.object({
  name: fields.trimmed(80).min(2),
  pincode: fields.trimmed(10).optional().or(z.literal('')),
  centerLat: fields.latitude,
  centerLng: fields.longitude,
  radiusKm: z.coerce.number().min(0.5).max(200).default(15),
  isActive: z.boolean().default(true),
});

router.get('/service-areas', ctrl.listServiceAreas);
router.post('/service-areas', validate({ body: serviceAreaBody }), ctrl.createServiceArea);
router.patch(
  '/service-areas/:id',
  validate({ params: idParam, body: serviceAreaBody.partial() }),
  ctrl.updateServiceArea
);
router.delete('/service-areas/:id', validate({ params: idParam }), ctrl.deleteServiceArea);

/* ---------- settings / chatbot knowledge ---------- */
router.get('/business-info', ctrl.getBusinessInfo);
router.put(
  '/business-info',
  validate({
    body: z.object({
      companyName: fields.trimmed(80).optional(),
      tagline: fields.trimmed(120).optional(),
      supportPhone: fields.trimmed(20).optional().or(z.literal('')),
      supportEmail: z.string().trim().email().optional().or(z.literal('')),
      workingHours: fields.trimmed(120).optional(),
      paymentMethods: z.array(fields.trimmed(40)).max(12).optional(),
      cancellationPolicy: fields.trimmed(600).optional(),
      refundPolicy: fields.trimmed(600).optional(),
      deliveryTimeNote: fields.trimmed(300).optional(),
      waterSource: fields.trimmed(300).optional(),
      notes: fields.trimmed(1000).optional().or(z.literal('')),
    }),
  }),
  ctrl.updateBusinessInfo
);

router.get('/support', ctrl.listConversations);

/* ---------- admins ---------- */
router.post(
  '/admins',
  validate({
    body: z.object({
      name: fields.trimmed(80).min(2),
      phone: fields.phone,
      password: z.string().min(10).max(200),
    }),
  }),
  ctrl.createAdmin
);

module.exports = router;
