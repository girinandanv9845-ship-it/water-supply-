'use strict';

const { prisma } = require('../config/db');
const { env } = require('../config/env');
const { ApiError, ok, asyncHandler } = require('../utils/apiResponse');
const orderService = require('../services/order.service');
const sockets = require('../sockets');
const { isValidLatLng } = require('../utils/geo');

/** Statuses a driver is permitted to set, and the guard for each. */
const DRIVER_TARGETS = ['DRIVER_ACCEPTED', 'CONFIRMED', 'OUT_FOR_DELIVERY', 'ARRIVING', 'DELIVERED', 'FAILED'];

/** GET /api/driver/me */
const profile = asyncHandler(async (req, res) => {
  const driver = await prisma.driverProfile.findUnique({
    where: { id: req.driverProfileId },
    include: {
      user: { select: { id: true, name: true, phone: true } },
      vehicles: { select: { id: true, registrationNumber: true, vehicleType: true, capacityL: true, status: true } },
    },
  });
  return ok(res, driver);
});

/** GET /api/driver/orders - assigned + active work, never other drivers' orders. */
const listOrders = asyncHandler(async (req, res) => {
  const { scope } = req.validatedQuery;

  const where = { driverId: req.driverProfileId };
  if (scope === 'active') {
    where.status = { in: ['DRIVER_ASSIGNED', 'DRIVER_ACCEPTED', 'OUT_FOR_DELIVERY', 'ARRIVING'] };
  } else if (scope === 'history') {
    where.status = { in: ['DELIVERED', 'CANCELLED', 'FAILED'] };
  }

  const orders = await prisma.order.findMany({
    where,
    include: orderService.ORDER_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: scope === 'history' ? 50 : 20,
  });

  return ok(res, orders.map((o) => orderService.serializeOrder(o, { viewerRole: 'DRIVER' })));
});

/** POST /api/driver/orders/:id/status */
const updateStatus = asyncHandler(async (req, res) => {
  const { status, note } = req.body;

  if (!DRIVER_TARGETS.includes(status)) {
    throw ApiError.forbidden('Drivers cannot set that status.');
  }

  // Ownership check - throws if the order is not this driver's.
  const order = await orderService.getAuthorizedOrder(req.params.id, req.user);

  const updated = await orderService.transitionOrder({
    orderId: order.id,
    to: status,
    actorRole: 'DRIVER',
    actorId: req.user.id,
    note: note || null,
  });

  // Keep driver availability and delivery counters honest.
  if (status === 'OUT_FOR_DELIVERY') {
    await prisma.driverProfile.update({
      where: { id: req.driverProfileId },
      data: { status: 'ON_DELIVERY' },
    });
  } else if (['DELIVERED', 'FAILED'].includes(status)) {
    const stillBusy = await prisma.order.count({
      where: {
        driverId: req.driverProfileId,
        status: { in: ['DRIVER_ACCEPTED', 'OUT_FOR_DELIVERY', 'ARRIVING'] },
      },
    });
    await prisma.driverProfile.update({
      where: { id: req.driverProfileId },
      data: {
        status: stillBusy > 0 ? 'ON_DELIVERY' : 'AVAILABLE',
        ...(status === 'DELIVERED' ? { totalDeliveries: { increment: 1 } } : {}),
      },
    });
  } else if (status === 'CONFIRMED') {
    // Driver rejected the job - unassign so dispatch can reallocate.
    await prisma.order.update({
      where: { id: order.id },
      data: { driverId: null, vehicleId: null, assignedAt: null },
    });
    await prisma.driverProfile.update({
      where: { id: req.driverProfileId },
      data: { status: 'AVAILABLE' },
    });
  }

  return ok(res, orderService.serializeOrder(updated, { viewerRole: 'DRIVER' }));
});

/**
 * POST /api/driver/location
 * HTTP fallback for browsers where the socket is unavailable. Same server-side
 * throttle contract as the socket path.
 */
const lastHttpLocationAt = new Map();

const updateLocation = asyncHandler(async (req, res) => {
  const { latitude, longitude, heading } = req.body;
  if (!isValidLatLng(latitude, longitude)) {
    throw ApiError.badRequest('Invalid coordinates.');
  }

  const now = Date.now();
  const last = lastHttpLocationAt.get(req.driverProfileId) || 0;
  if (now - last < env.LOCATION_MIN_INTERVAL_MS) {
    return ok(res, { accepted: false, throttled: true });
  }
  lastHttpLocationAt.set(req.driverProfileId, now);

  await prisma.driverProfile.update({
    where: { id: req.driverProfileId },
    data: {
      currentLat: latitude,
      currentLng: longitude,
      heading: Number.isFinite(heading) ? heading : null,
      lastLocationAt: new Date(),
    },
  });

  await sockets.broadcastDriverLocation(req.driverProfileId, latitude, longitude, heading);
  return ok(res, { accepted: true });
});

/** POST /api/driver/availability - driver goes online/offline. */
const setAvailability = asyncHandler(async (req, res) => {
  const { available } = req.body;

  const busy = await prisma.order.count({
    where: {
      driverId: req.driverProfileId,
      status: { in: ['DRIVER_ACCEPTED', 'OUT_FOR_DELIVERY', 'ARRIVING'] },
    },
  });
  if (!available && busy > 0) {
    throw ApiError.conflict('Finish or hand over your active deliveries before going offline.');
  }

  const driver = await prisma.driverProfile.update({
    where: { id: req.driverProfileId },
    data: { status: available ? 'AVAILABLE' : 'OFFLINE' },
  });

  sockets.emitToAdmins('admin:driver-status', { driverId: driver.id, status: driver.status });
  return ok(res, { status: driver.status });
});

module.exports = { profile, listOrders, updateStatus, updateLocation, setAvailability };
