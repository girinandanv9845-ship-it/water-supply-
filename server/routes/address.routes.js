'use strict';

const express = require('express');
const { prisma } = require('../config/db');
const { ApiError, ok, created, asyncHandler } = require('../utils/apiResponse');
const { requireAuth } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth);

const addressBody = z.object({
  label: fields.trimmed(40).min(1).default('Home'),
  fullAddress: fields.trimmed(400).min(5),
  landmark: fields.trimmed(200).optional().or(z.literal('')),
  latitude: fields.latitude,
  longitude: fields.longitude,
  isDefault: z.boolean().optional().default(false),
});

/** GET /api/addresses - the caller's own addresses only. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const addresses = await prisma.address.findMany({
      where: { userId: req.user.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return ok(res, addresses);
  })
);

/** POST /api/addresses */
router.post(
  '/',
  validate({ body: addressBody }),
  asyncHandler(async (req, res) => {
    const { isDefault, landmark, ...rest } = req.body;

    const address = await prisma.$transaction(async (tx) => {
      const count = await tx.address.count({ where: { userId: req.user.id } });
      const makeDefault = isDefault || count === 0;
      if (makeDefault) {
        await tx.address.updateMany({ where: { userId: req.user.id }, data: { isDefault: false } });
      }
      return tx.address.create({
        data: { ...rest, landmark: landmark || null, isDefault: makeDefault, userId: req.user.id },
      });
    });

    return created(res, address);
  })
);

/** PATCH /api/addresses/:id */
router.patch(
  '/:id',
  validate({ params: z.object({ id: fields.cuid }), body: addressBody.partial() }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.address.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== req.user.id) throw ApiError.notFound('Address not found.');

    const { isDefault, ...rest } = req.body;
    const address = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.address.updateMany({ where: { userId: req.user.id }, data: { isDefault: false } });
      }
      return tx.address.update({
        where: { id: req.params.id },
        data: { ...rest, ...(isDefault !== undefined ? { isDefault } : {}) },
      });
    });
    return ok(res, address);
  })
);

/** DELETE /api/addresses/:id */
router.delete(
  '/:id',
  validate({ params: z.object({ id: fields.cuid }) }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.address.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== req.user.id) throw ApiError.notFound('Address not found.');

    // An address referenced by an order cannot be hard-deleted (FK restrict).
    const inUse = await prisma.order.count({
      where: { addressId: req.params.id, status: { notIn: ['DELIVERED', 'CANCELLED', 'FAILED'] } },
    });
    if (inUse > 0) {
      throw ApiError.conflict('This address is used by an active order and cannot be removed yet.');
    }

    try {
      await prisma.address.delete({ where: { id: req.params.id } });
    } catch (err) {
      if (err.code === 'P2003') {
        throw ApiError.conflict('This address is linked to past orders and cannot be removed.');
      }
      throw err;
    }
    return ok(res, { deleted: true });
  })
);

module.exports = router;
