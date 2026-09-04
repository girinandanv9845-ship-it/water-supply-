'use strict';

const { prisma } = require('../config/db');
const { ApiError, ok, created, asyncHandler } = require('../utils/apiResponse');
const orderService = require('../services/order.service');
const fsm = require('../utils/orderStateMachine');

/** POST /api/orders */
const create = asyncHandler(async (req, res) => {
  // Note what is NOT read from the body: price, total, status, customerId.
  const order = await orderService.createOrder({
    customerId: req.user.id,
    productId: req.body.productId,
    addressId: req.body.addressId,
    quantity: req.body.quantity,
    notes: req.body.notes || null,
    paymentMethod: req.body.paymentMethod,
    scheduledFor: req.body.scheduledFor ? new Date(req.body.scheduledFor) : null,
  });

  // Cash-on-delivery needs no payment step, so confirm it immediately.
  if (order.paymentMethod === 'CASH_ON_DELIVERY') {
    const confirmed = await orderService.transitionOrder({
      orderId: order.id,
      to: 'CONFIRMED',
      actorRole: 'SYSTEM',
      note: 'Cash on delivery order confirmed',
    });
    return created(res, orderService.serializeOrder(confirmed, { viewerRole: 'CUSTOMER' }));
  }

  return created(res, orderService.serializeOrder(order, { viewerRole: 'CUSTOMER' }));
});

/** GET /api/orders - the caller's own order history. */
const list = asyncHandler(async (req, res) => {
  const { page, limit, status } = req.validatedQuery;
  const where = { customerId: req.user.id };
  if (status) where.status = status;

  const [total, orders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      include: orderService.ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return ok(
    res,
    orders.map((o) => orderService.serializeOrder(o, { viewerRole: 'CUSTOMER' })),
    { page, limit, total, pages: Math.ceil(total / limit) || 1 }
  );
});

/** GET /api/orders/active - what the home screen tracks. */
const active = asyncHandler(async (req, res) => {
  const orders = await prisma.order.findMany({
    where: {
      customerId: req.user.id,
      status: { notIn: ['DELIVERED', 'CANCELLED', 'FAILED'] },
    },
    include: orderService.ORDER_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  return ok(res, orders.map((o) => orderService.serializeOrder(o, { viewerRole: 'CUSTOMER' })));
});

/** GET /api/orders/:id */
const getOne = asyncHandler(async (req, res) => {
  const order = await orderService.getAuthorizedOrder(req.params.id, req.user);
  return ok(res, orderService.serializeOrder(order, { viewerRole: req.user.role }));
});

/** GET /api/orders/:id/track - lightweight polling fallback for the live map. */
const track = asyncHandler(async (req, res) => {
  const order = await orderService.getAuthorizedOrder(req.params.id, req.user);
  const view = orderService.serializeOrder(order, { viewerRole: req.user.role });
  return ok(res, {
    orderId: view.id,
    status: view.status,
    statusLabel: view.statusLabel,
    etaMinutes: view.etaMinutes,
    distanceKm: view.distanceKm,
    destination: { latitude: view.latitude, longitude: view.longitude },
    driver: view.driver,
    updatedAt: view.updatedAt,
  });
});

/** POST /api/orders/:id/cancel */
const cancel = asyncHandler(async (req, res) => {
  const order = await orderService.getAuthorizedOrder(req.params.id, req.user);

  if (req.user.role === 'CUSTOMER' && !fsm.CUSTOMER_CANCELLABLE.has(order.status)) {
    throw ApiError.conflict(
      'This order can no longer be cancelled from the app because the tanker is already on its way. Please call support.'
    );
  }

  const updated = await orderService.transitionOrder({
    orderId: order.id,
    to: 'CANCELLED',
    actorRole: req.user.role,
    actorId: req.user.id,
    note: req.body.reason || 'Cancelled by customer',
    extraData: { cancelReason: req.body.reason || 'Cancelled by customer' },
  });

  // Free the driver if one had been assigned.
  if (updated.driverId) {
    await prisma.driverProfile.update({
      where: { id: updated.driverId },
      data: { status: 'AVAILABLE' },
    }).catch(() => {});
  }

  return ok(res, orderService.serializeOrder(updated, { viewerRole: req.user.role }));
});

module.exports = { create, list, active, getOne, track, cancel };
