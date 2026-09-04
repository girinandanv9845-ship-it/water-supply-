'use strict';

const express = require('express');
const { prisma } = require('../config/db');
const { ok, asyncHandler } = require('../utils/apiResponse');
const { requireAuth } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth);

/** GET /api/notifications */
router.get(
  '/',
  validate({ query: fields.pagination }),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.validatedQuery;
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
    ]);
    return ok(res, items, { unread, page, limit });
  })
);

/** POST /api/notifications/read - marks all (or specific ids) as read. */
router.post(
  '/read',
  validate({ body: z.object({ ids: z.array(fields.cuid).max(100).optional() }) }),
  asyncHandler(async (req, res) => {
    const where = { userId: req.user.id, readAt: null };
    if (req.body.ids && req.body.ids.length) where.id = { in: req.body.ids };
    const { count } = await prisma.notification.updateMany({ where, data: { readAt: new Date() } });
    return ok(res, { updated: count });
  })
);

module.exports = router;
