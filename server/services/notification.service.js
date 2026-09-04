'use strict';

const { prisma } = require('../config/db');
const sockets = require('../sockets');
const logger = require('../utils/logger');

/**
 * Channel-agnostic notification dispatch.
 *
 * IN_APP is implemented (persisted + pushed over the socket). SMS / WhatsApp /
 * EMAIL / PUSH are declared as providers with a null implementation, so wiring
 * a real gateway later is a single file change rather than a refactor.
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
    isConfigured: () => Boolean(process.env.SMS_PROVIDER_KEY),
    async send() {
      // Wire Twilio/MSG91 here; falls through to IN_APP until configured.
      return { delivered: false, reason: 'SMS provider not configured' };
    },
  },
  WHATSAPP: {
    isConfigured: () => Boolean(process.env.WHATSAPP_PROVIDER_KEY),
    async send() {
      return { delivered: false, reason: 'WhatsApp provider not configured' };
    },
  },
  EMAIL: {
    isConfigured: () => Boolean(process.env.SMTP_URL),
    async send() {
      return { delivered: false, reason: 'Email provider not configured' };
    },
  },
  PUSH: {
    isConfigured: () => Boolean(process.env.PUSH_PROVIDER_KEY),
    async send() {
      return { delivered: false, reason: 'Push provider not configured' };
    },
  },
};

/**
 * Persists an in-app notification and fans it out to any configured external
 * channels. Never throws - a failed notification must not fail the order.
 */
async function notify({ userId, title, body, orderId = null, channels = ['IN_APP'] }) {
  if (!userId) return null;
  try {
    const record = await prisma.notification.create({
      data: { userId, title, body, orderId, channel: 'IN_APP' },
    });

    for (const channel of channels) {
      const provider = providers[channel];
      if (!provider) continue;
      if (channel !== 'IN_APP' && !provider.isConfigured()) continue;
      try {
        await provider.send({ ...record, userId });
      } catch (err) {
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

module.exports = { notify, notifyOrderStatus, notifyPayment, providers };
