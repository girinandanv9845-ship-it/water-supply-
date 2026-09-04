'use strict';

const crypto = require('crypto');
const { prisma } = require('../config/db');
const { ApiError } = require('../utils/apiResponse');
const fsm = require('../utils/orderStateMachine');
const geo = require('../utils/geo');
const sockets = require('../sockets');
const notifications = require('./notification.service');
const logger = require('../utils/logger');

/** Shape returned to clients - never leaks other customers' data. */
const ORDER_INCLUDE = {
  product: { select: { id: true, name: true, slug: true, capacityL: true, imageEmoji: true } },
  address: { select: { id: true, label: true, fullAddress: true, landmark: true, latitude: true, longitude: true } },
  customer: { select: { id: true, name: true, phone: true } },
  driver: {
    select: {
      id: true,
      status: true,
      currentLat: true,
      currentLng: true,
      lastLocationAt: true,
      user: { select: { id: true, name: true, phone: true } },
    },
  },
  vehicle: { select: { id: true, registrationNumber: true, vehicleType: true, capacityL: true } },
  payments: {
    select: { id: true, status: true, amountInPaise: true, provider: true, isDemo: true, paidAt: true },
    orderBy: { createdAt: 'desc' },
  },
  events: { select: { status: true, note: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
};

function generateOrderNumber() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `AQ-${stamp}-${rand}`;
}

/**
 * Presentation view. Driver phone/live position are only included once the
 * driver has actually accepted, and never for terminal orders.
 */
function serializeOrder(order, { viewerRole = 'CUSTOMER' } = {}) {
  if (!order) return null;

  const showDriverContact =
    order.driver &&
    ['DRIVER_ASSIGNED', 'DRIVER_ACCEPTED', 'OUT_FOR_DELIVERY', 'ARRIVING'].includes(order.status);

  let etaMinutes = null;
  let distanceKm = null;
  if (
    order.driver &&
    Number.isFinite(order.driver.currentLat) &&
    Number.isFinite(order.driver.currentLng) &&
    ['DRIVER_ACCEPTED', 'OUT_FOR_DELIVERY', 'ARRIVING'].includes(order.status)
  ) {
    distanceKm = Number(
      geo.haversineKm(order.driver.currentLat, order.driver.currentLng, order.latitude, order.longitude).toFixed(2)
    );
    etaMinutes = geo.estimateEtaMinutes(distanceKm);
  }

  const payment = order.payments && order.payments[0];

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    statusLabel: fsm.CUSTOMER_LABELS[order.status] || order.status,
    isTerminal: fsm.isTerminal(order.status),
    loadType: order.loadType,
    quantityL: order.quantityL,
    quantity: order.quantity,
    unitPriceInPaise: order.unitPriceInPaise,
    totalInPaise: order.totalInPaise,
    totalRupees: order.totalInPaise / 100,
    paymentMethod: order.paymentMethod,
    paymentStatus: payment ? payment.status : 'PENDING',
    isDemoPayment: payment ? payment.isDemo : false,
    deliveryAddressText: order.deliveryAddressText,
    latitude: order.latitude,
    longitude: order.longitude,
    notes: order.notes,
    cancelReason: order.cancelReason,
    estimatedArrival: order.estimatedArrival,
    etaMinutes,
    distanceKm,
    canCancel: fsm.CUSTOMER_CANCELLABLE.has(order.status),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    deliveredAt: order.deliveredAt,
    product: order.product || null,
    address: order.address || null,
    vehicle: order.vehicle || null,
    customer:
      viewerRole === 'CUSTOMER'
        ? undefined
        : order.customer && { id: order.customer.id, name: order.customer.name, phone: order.customer.phone },
    driver: order.driver
      ? {
          id: order.driver.id,
          name: order.driver.user.name,
          phone: showDriverContact ? order.driver.user.phone : undefined,
          latitude: showDriverContact ? order.driver.currentLat : undefined,
          longitude: showDriverContact ? order.driver.currentLng : undefined,
          lastLocationAt: showDriverContact ? order.driver.lastLocationAt : undefined,
        }
      : null,
    timeline: (order.events || []).map((e) => ({
      status: e.status,
      label: fsm.CUSTOMER_LABELS[e.status] || e.status,
      note: e.note,
      at: e.createdAt,
    })),
    nextActions: {
      DRIVER: fsm.nextStatuses(order.status, 'DRIVER'),
      ADMIN: fsm.nextStatuses(order.status, 'ADMIN'),
    },
  };
}

async function getOrderOr404(orderId) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
  if (!order) throw ApiError.notFound('That order does not exist.');
  return order;
}

/**
 * Ownership check. Central so no controller can forget it.
 * Returns the order, or throws 403/404.
 */
async function getAuthorizedOrder(orderId, user) {
  const order = await getOrderOr404(orderId);
  if (user.role === 'ADMIN') return order;
  if (user.role === 'CUSTOMER') {
    if (order.customerId !== user.id) throw ApiError.notFound('That order does not exist.');
    return order;
  }
  if (user.role === 'DRIVER') {
    const driverId = user.driverProfile && user.driverProfile.id;
    if (!driverId || order.driverId !== driverId) {
      throw ApiError.forbidden('That order is not assigned to you.');
    }
    return order;
  }
  throw ApiError.forbidden();
}

/**
 * The ONE place an order status may change.
 *
 * @param {object} opts
 * @param {string} opts.orderId
 * @param {string} opts.to           target status
 * @param {'CUSTOMER'|'DRIVER'|'ADMIN'|'SYSTEM'} opts.actorRole
 * @param {string} [opts.actorId]
 * @param {string} [opts.note]
 * @param {object} [opts.extraData]  additional columns to write in the same transaction
 */
async function transitionOrder({ orderId, to, actorRole, actorId = null, note = null, extraData = {} }) {
  const current = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, customerId: true, driverId: true },
  });
  if (!current) throw ApiError.notFound('That order does not exist.');

  try {
    fsm.assertTransition(current.status, to, actorRole);
  } catch (err) {
    throw ApiError.conflict(err.message, { from: current.status, to });
  }

  const data = { status: to, ...extraData };
  const stampColumn = fsm.timestampFor(to);
  if (stampColumn && !data[stampColumn]) data[stampColumn] = new Date();

  // Status change + audit event in one transaction: the timeline can never
  // disagree with the order row.
  const [updated] = await prisma.$transaction([
    prisma.order.update({ where: { id: orderId }, data, include: ORDER_INCLUDE }),
    prisma.orderEvent.create({
      data: { orderId, status: to, note, actorId, actorRole: actorRole === 'SYSTEM' ? null : actorRole },
    }),
  ]);

  await fanOutOrderUpdate(updated);
  return updated;
}

/** Pushes an order change to every party entitled to see it. */
async function fanOutOrderUpdate(order) {
  try {
    const customerView = serializeOrder(order, { viewerRole: 'CUSTOMER' });
    const staffView = serializeOrder(order, { viewerRole: 'ADMIN' });

    sockets.emitToOrder(order.id, 'order:update', customerView);
    sockets.emitToUser(order.customerId, 'order:update', customerView);
    if (order.driverId) sockets.emitToDriver(order.driverId, 'driver:order-update', staffView);
    sockets.emitToAdmins('admin:order-update', staffView);

    await notifications.notifyOrderStatus(order);
  } catch (err) {
    // Never let a notification failure roll back a completed status change.
    logger.error(`Order fan-out failed for ${order.id}: ${err.message}`);
  }
}

/**
 * Creates an order. Price is read from the Product row - the client's idea of
 * the price is ignored entirely.
 */
async function createOrder({ customerId, productId, addressId, quantity = 1, notes = null, paymentMethod = 'ONLINE', scheduledFor = null }) {
  const [product, address] = await Promise.all([
    prisma.product.findUnique({ where: { id: productId } }),
    prisma.address.findUnique({ where: { id: addressId } }),
  ]);

  if (!product || !product.isActive) {
    throw ApiError.badRequest('That water load is not available right now.');
  }
  if (!address || address.userId !== customerId) {
    throw ApiError.badRequest('Select one of your saved addresses.');
  }

  // Server-side pricing. Authoritative.
  const unitPriceInPaise = product.priceInPaise;
  const totalInPaise = unitPriceInPaise * quantity;

  const serviceable = await isServiceable(address.latitude, address.longitude);
  if (!serviceable.ok) {
    throw ApiError.badRequest(serviceable.message);
  }

  const order = await prisma.order.create({
    data: {
      orderNumber: generateOrderNumber(),
      customerId,
      addressId,
      productId,
      loadType: product.name,
      quantityL: product.capacityL * quantity,
      unitPriceInPaise,
      quantity,
      totalInPaise,
      paymentMethod,
      latitude: address.latitude,
      longitude: address.longitude,
      deliveryAddressText: address.fullAddress,
      notes,
      scheduledFor,
      status: 'PENDING',
      events: { create: { status: 'PENDING', note: 'Order placed', actorId: customerId, actorRole: 'CUSTOMER' } },
    },
    include: ORDER_INCLUDE,
  });

  sockets.emitToAdmins('admin:order-new', serializeOrder(order, { viewerRole: 'ADMIN' }));
  return order;
}

/** Checks the delivery point against configured service areas. */
async function isServiceable(lat, lng) {
  const areas = await prisma.serviceArea.findMany({ where: { isActive: true } });
  // No areas configured = unrestricted (useful before an operator sets them up).
  if (areas.length === 0) return { ok: true };

  const within = areas.some(
    (a) => geo.haversineKm(lat, lng, a.centerLat, a.centerLng) <= a.radiusKm
  );
  return within
    ? { ok: true }
    : { ok: false, message: 'We do not deliver to that location yet. Try an address inside our service area.' };
}

/** Refreshes the stored ETA from the driver's last known position. */
async function refreshEta(orderId) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { driver: { select: { currentLat: true, currentLng: true } } },
  });
  if (!order || !order.driver || !Number.isFinite(order.driver.currentLat)) return null;

  const distanceKm = geo.haversineKm(
    order.driver.currentLat,
    order.driver.currentLng,
    order.latitude,
    order.longitude
  );
  const minutes = geo.estimateEtaMinutes(distanceKm);
  const estimatedArrival = new Date(Date.now() + minutes * 60 * 1000);
  await prisma.order.update({ where: { id: orderId }, data: { estimatedArrival } });
  return { etaMinutes: minutes, estimatedArrival, distanceKm };
}

module.exports = {
  ORDER_INCLUDE,
  serializeOrder,
  createOrder,
  transitionOrder,
  fanOutOrderUpdate,
  getOrderOr404,
  getAuthorizedOrder,
  isServiceable,
  refreshEta,
  generateOrderNumber,
};
