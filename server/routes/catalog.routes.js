'use strict';

const express = require('express');
const { prisma } = require('../config/db');
const { env } = require('../config/env');
const { ok, asyncHandler } = require('../utils/apiResponse');
const businessInfo = require('../services/businessInfo.service');
const orderService = require('../services/order.service');
const { validate, z, fields } = require('../middleware/validate');

const router = express.Router();

/** GET /api/products - public catalog, active items only. */
router.get(
  '/products',
  asyncHandler(async (req, res) => {
    const products = await prisma.product.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        capacityL: true,
        priceInPaise: true,
        vehicleType: true,
        imageEmoji: true,
      },
    });
    return ok(
      res,
      products.map((p) => ({ ...p, priceRupees: p.priceInPaise / 100 }))
    );
  })
);

/** GET /api/service-areas */
router.get(
  '/service-areas',
  asyncHandler(async (req, res) => {
    const areas = await prisma.serviceArea.findMany({
      where: { isActive: true },
      select: { id: true, name: true, pincode: true, centerLat: true, centerLng: true, radiusKm: true },
    });
    return ok(res, areas);
  })
);

/** GET /api/serviceability?latitude=&longitude= - pre-checkout coverage check. */
router.get(
  '/serviceability',
  validate({ query: z.object({ latitude: fields.latitude, longitude: fields.longitude }) }),
  asyncHandler(async (req, res) => {
    const { latitude, longitude } = req.validatedQuery;
    const result = await orderService.isServiceable(latitude, longitude);
    return ok(res, { serviceable: result.ok, message: result.message || 'We deliver to this location.' });
  })
);

/** GET /api/business-info - powers the chatbot UI and the app footer. */
router.get(
  '/business-info',
  asyncHandler(async (req, res) => ok(res, await businessInfo.getBusinessInfo()))
);

/**
 * GET /api/config - runtime feature flags + the browser Maps key.
 *
 * The Maps key is a publishable, HTTP-referrer-restricted browser key. It is
 * served from the environment rather than hardcoded in the HTML so it can be
 * rotated without a code change. Restrict it in Google Cloud Console.
 */
router.get(
  '/config',
  asyncHandler(async (req, res) =>
    ok(res, {
      demoMode: env.DEMO_MODE,
      mapsEnabled: env.MAPS_ENABLED,
      googleMapsApiKey: env.GOOGLE_MAPS_API_KEY || null,
      razorpayEnabled: env.RAZORPAY_ENABLED,
      razorpayKeyId: env.RAZORPAY_KEY_ID || null,
      aiEnabled: env.AI_ENABLED,
      aiProvider: env.AI_ENABLED ? env.AI_PROVIDER : 'fallback',
    })
  )
);

module.exports = router;
