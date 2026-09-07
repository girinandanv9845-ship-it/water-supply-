'use strict';

const { prisma } = require('../config/db');
const sockets = require('../sockets');
const sms = require('./sms.service');
const email = require('./email.service');
const logger = require('../utils/logger');

/**
 * Channel-agnostic notification dispatch.
 *
 * IN_APP is always on (persisted + pushed over the socket). SMS and EMAIL run
 * through the same gateways as login codes, so configuring one provider covers
 * both OTPs and order updates.
 *
 * External channels are opt-in via NOTIFY_CHANNELS, because every SMS costs
 * money and an update per status change is six messages a delivery. Example:
 *   NOTIFY_CHANNELS=IN_APP,EMAIL
 */

const providers = {
  IN_APP: {
    isConfigured: () => true,
    async send(notification) {
      sockets.emitToUser(notification.userId, 'notification', notification);
      return { delivered: true };
    },
  },
  SMS: {
    isConfigured: () => sms.isConfigured(),
    async send(notification, contact) {
      if (!contact.phone) return { delivered: false, reason: 'No phone on file' };
      const result = await sms.send(contact.phone, `${notification.title}: ${notification.body}`);
      return { delivered: result.sent, reason: result.error };
    },
  },
  EMAIL: {
    isConfigured: () => email.isConfigured(),
    async send(notification, contact) {
      if (!contact.email) return { delivered: false, reason: 'No email on file' };
      const result = await email.send({
        to: contact.email,
        subject: notification.title,
        text: notification.body,
      });
      return { delivered: result.sent, reason: result.error };
    },
  },
  WHATSAPP: {
    isConfigured: () => Boolean(process.env.WHATSAPP_PROVIDER_KEY),
    async send() {
      return { delivered: false, reason: 'WhatsApp provider not configured' };
    },
  },
  PUSH: {
    isConfigured: () => Boolean(process.env.PUSH_PROVIDER_KEY),
    async send() {
      return { delivered: false, reason: 'Push provider not configured' };
    },
  },
};

/** Channels every notification attempts, from NOTIFY_CHANNELS. */
function defaultChannels() {
  const raw = (process.env.NOTIFY_CHANNELS || 'IN_APP')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => providers[c]);
  // IN_APP is not optional - it is what the bell icon reads from.
  return raw.includes('IN_APP') ? raw : ['IN_APP'].concat(raw);
}

/**
 * Persists an in-app notification and fans it out to any configured external
 * channels. Never throws - a failed notification must not fail the order.
 */
async function notify({ userId, title, body, orderId = null, channels = null }) {
  if (!userId) return null;
  try {
    const record = await prisma.notification.create({
      data: { userId, title, body, orderId, channel: 'IN_APP' },
    });

    const wanted = channels || defaultChannels();

    // Only look up contact details when an external channel actually needs
    // them - the common IN_APP-only path stays a single insert.
    let contact = { phone: null, email: null };
    if (wanted.some((c) => c !== 'IN_APP')) {
      contact =
        (await prisma.user.findUnique({
          where: { id: userId },
          select: { phone: true, email: true },
        })) || contact;
    }

    for (const channel of wanted) {
      const provider = providers[channel];
      if (!provider) continue;
      if (channel !== 'IN_APP' && !provider.isConfigured()) continue;
      try {
        const result = await provider.send({ ...record, userId }, contact);
        if (result && !result.delivered && channel !== 'IN_APP') {
          logger.debug(`Notification channel ${channel} skipped: ${result.reason}`);
        }
      } catch (err) {
        // A notification must never fail the order it is reporting on.
        logger.warn(`Notification channel ${channel} failed: ${err.message}`);
      }
    }
    return record;
  } catch (err) {
    logger.error(`Failed to store notification: ${err.message}`);
    return null;
  }
}

/** Human-readable copy for each order status change. */
const ORDER_MESSAGES = {
  CONFIRMED: (o) => ({
    title: 'Order confirmed',
    body: `Your ${o.loadType} (${o.quantityL}L) order ${o.orderNumber} is confirmed. We are assigning a tanker.`,
  }),
  DRIVER_ASSIGNED: (o) => ({
    title: 'Tanker assigned',
    body: `A tanker has been assigned to order ${o.orderNumber}. You can track it live.`,
  }),
  DRIVER_ACCEPTED: (o) => ({
    title: 'Driver accepted',
    body: `Your driver has accepted order ${o.orderNumber} and will start shortly.`,
  }),
  OUT_FOR_DELIVERY: (o) => ({
    title: 'Tanker on the way',
    body: `Your water is on the way for order ${o.orderNumber}. Track it live in the app.`,
  }),
  ARRIVING: (o) => ({
    title: 'Arriving now',
    body: `Your tanker is arriving for order ${o.orderNumber}. Please be available.`,
  }),
  DELIVERED: (o) => ({
    title: 'Delivered',
    body: `Order ${o.orderNumber} has been delivered. Thank you for choosing us.`,
  }),
  CANCELLED: (o) => ({
    title: 'Order cancelled',
    body: `Order ${o.orderNumber} was cancelled.${o.cancelReason ? ` Reason: ${o.cancelReason}` : ''}`,
  }),
  FAILED: (o) => ({
    title: 'Delivery failed',
    body: `We could not complete order ${o.orderNumber}. Our support team will contact you.`,
  }),
  PAYMENT_FAILED: (o) => ({
    title: 'Payment failed',
    body: `Payment for order ${o.orderNumber} did not go through. You can retry from your orders list.`,
  }),
};

async function notifyOrderStatus(order) {
  const build = ORDER_MESSAGES[order.status];
  if (!build) return null;
  const { title, body } = build(order);
  return notify({ userId: order.customerId, title, body, orderId: order.id });
}

async function notifyPayment(order, success, reason) {
  return notify({
    userId: order.customerId,
    orderId: order.id,
    title: success ? 'Payment successful' : 'Payment failed',
    body: success
      ? `We received ${(order.totalInPaise / 100).toFixed(2)} INR for order ${order.orderNumber}.`
      : `Payment for order ${order.orderNumber} failed.${reason ? ` ${reason}` : ''} You can retry from your orders.`,
  });
}

module.exports = { notify, notifyOrderStatus, notifyPayment, providers, defaultChannels };
