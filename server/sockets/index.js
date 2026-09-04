'use strict';

const { Server } = require('socket.io');
const { env } = require('../config/env');
const { prisma } = require('../config/db');
const { resolveUser } = require('../middleware/auth');
const { haversineKm, estimateEtaMinutes, isValidLatLng } = require('../utils/geo');
const logger = require('../utils/logger');

/**
 * Room model - nothing is ever broadcast to all sockets:
 *   user:<userId>     private notifications for one account
 *   order:<orderId>   the customer, the assigned driver and admins for that order
 *   driver:<driverId> that driver's own channel
 *   admins            every signed-in admin
 */

let io = null;

// driverProfileId -> last accepted GPS timestamp, for server-side throttling.
const lastLocationAt = new Map();

function roomForUser(userId) {
  return `user:${userId}`;
}
function roomForOrder(orderId) {
  return `order:${orderId}`;
}
function roomForDriver(driverProfileId) {
  return `driver:${driverProfileId}`;
}
const ADMIN_ROOM = 'admins';

/** True when this user is allowed to watch this order. */
async function canAccessOrder(user, orderId) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, customerId: true, driverId: true },
  });
  if (!order) return false;
  if (user.role === 'ADMIN') return true;
  if (user.role === 'CUSTOMER') return order.customerId === user.id;
  if (user.role === 'DRIVER') {
    return Boolean(user.driverProfile) && order.driverId === user.driverProfile.id;
  }
  return false;
}

function initSockets(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : true,
      credentials: true,
    },
    // Tanker drivers are frequently on flaky mobile networks.
    pingTimeout: 25000,
    pingInterval: 20000,
  });

  // Authenticate at handshake - an unauthenticated socket never joins a room.
  io.use(async (socket, next) => {
    try {
      const token =
        (socket.handshake.auth && socket.handshake.auth.token) ||
        (socket.handshake.query && socket.handshake.query.token);
      const user = await resolveUser(token);
      if (!user) return next(new Error('UNAUTHORIZED'));
      socket.data.user = user;
      return next();
    } catch (err) {
      logger.warn(`Socket auth failed: ${err.message}`);
      return next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;

    socket.join(roomForUser(user.id));
    if (user.role === 'ADMIN') socket.join(ADMIN_ROOM);
    if (user.role === 'DRIVER' && user.driverProfile) {
      socket.join(roomForDriver(user.driverProfile.id));
    }

    logger.debug(`Socket connected: ${user.role} ${user.id}`);

    /** Customer/driver/admin subscribing to one order's live feed. */
    socket.on('order:subscribe', async (payload, ack) => {
      try {
        const orderId = payload && payload.orderId;
        if (!orderId || typeof orderId !== 'string') {
          return typeof ack === 'function' && ack({ ok: false, error: 'orderId is required' });
        }
        if (!(await canAccessOrder(user, orderId))) {
          return typeof ack === 'function' && ack({ ok: false, error: 'Not allowed' });
        }
        socket.join(roomForOrder(orderId));
        return typeof ack === 'function' && ack({ ok: true });
      } catch (err) {
        logger.error(`order:subscribe failed: ${err.message}`);
        return typeof ack === 'function' && ack({ ok: false, error: 'Subscribe failed' });
      }
    });

    socket.on('order:unsubscribe', (payload) => {
      if (payload && typeof payload.orderId === 'string') {
        socket.leave(roomForOrder(payload.orderId));
      }
    });

    /**
     * Driver GPS ping. Throttled server-side; only forwarded to the rooms of
     * that driver's own active orders, never broadcast.
     */
    socket.on('driver:location', async (payload, ack) => {
      try {
        if (user.role !== 'DRIVER' || !user.driverProfile) {
          return typeof ack === 'function' && ack({ ok: false, error: 'Driver only' });
        }
        const lat = Number(payload && payload.latitude);
        const lng = Number(payload && payload.longitude);
        if (!isValidLatLng(lat, lng)) {
          return typeof ack === 'function' && ack({ ok: false, error: 'Invalid coordinates' });
        }

        const driverId = user.driverProfile.id;
        const now = Date.now();
        const last = lastLocationAt.get(driverId) || 0;
        if (now - last < env.LOCATION_MIN_INTERVAL_MS) {
          // Silently drop - the client is over-reporting.
          return typeof ack === 'function' && ack({ ok: true, throttled: true });
        }
        lastLocationAt.set(driverId, now);

        await prisma.driverProfile.update({
          where: { id: driverId },
          data: {
            currentLat: lat,
            currentLng: lng,
            heading: Number.isFinite(Number(payload.heading)) ? Number(payload.heading) : null,
            lastLocationAt: new Date(),
          },
        });

        await broadcastDriverLocation(driverId, lat, lng, payload.heading);
        return typeof ack === 'function' && ack({ ok: true });
      } catch (err) {
        logger.error(`driver:location failed: ${err.message}`);
        return typeof ack === 'function' && ack({ ok: false, error: 'Location update failed' });
      }
    });

    socket.on('disconnect', () => {
      logger.debug(`Socket disconnected: ${user.id}`);
    });
  });

  return io;
}

/**
 * Pushes a driver's position to every order room that driver is actively
 * delivering, plus the admin live-map room.
 */
async function broadcastDriverLocation(driverProfileId, latitude, longitude, heading) {
  if (!io) return;

  const activeOrders = await prisma.order.findMany({
    where: {
      driverId: driverProfileId,
      status: { in: ['DRIVER_ACCEPTED', 'OUT_FOR_DELIVERY', 'ARRIVING'] },
    },
    select: { id: true, latitude: true, longitude: true },
  });

  const at = new Date().toISOString();

  for (const order of activeOrders) {
    const distanceKm = haversineKm(latitude, longitude, order.latitude, order.longitude);
    io.to(roomForOrder(order.id)).emit('driver:location', {
      orderId: order.id,
      latitude,
      longitude,
      heading: heading ?? null,
      distanceKm: Number(distanceKm.toFixed(2)),
      etaMinutes: estimateEtaMinutes(distanceKm),
      at,
    });
  }

  io.to(ADMIN_ROOM).emit('admin:driver-location', {
    driverId: driverProfileId,
    latitude,
    longitude,
    heading: heading ?? null,
    activeOrders: activeOrders.length,
    at,
  });
}

/* ---------- emit helpers used by services/controllers ---------- */

function emitToUser(userId, event, payload) {
  if (io) io.to(roomForUser(userId)).emit(event, payload);
}

function emitToOrder(orderId, event, payload) {
  if (io) io.to(roomForOrder(orderId)).emit(event, payload);
}

function emitToDriver(driverProfileId, event, payload) {
  if (io) io.to(roomForDriver(driverProfileId)).emit(event, payload);
}

function emitToAdmins(event, payload) {
  if (io) io.to(ADMIN_ROOM).emit(event, payload);
}

function getIo() {
  return io;
}

module.exports = {
  initSockets,
  getIo,
  emitToUser,
  emitToOrder,
  emitToDriver,
  emitToAdmins,
  broadcastDriverLocation,
  roomForUser,
  roomForOrder,
  roomForDriver,
  ADMIN_ROOM,
};
