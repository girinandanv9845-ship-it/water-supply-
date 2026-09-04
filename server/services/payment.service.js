'use strict';

const crypto = require('crypto');
const Razorpay = require('razorpay');
const { prisma } = require('../config/db');
const { env } = require('../config/env');
const { ApiError } = require('../utils/apiResponse');
const orderService = require('./order.service');
const notifications = require('./notification.service');
const logger = require('../utils/logger');

/**
 * Razorpay integration.
 *
 * Rules enforced here:
 *  - the amount always comes from the Order row, never from the request body
 *  - the signature is verified server-side with the secret key
 *  - a PAID payment is never reprocessed (idempotent verify)
 *  - the secret key never leaves this module
 */

let client = null;
if (env.RAZORPAY_ENABLED) {
  client = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
  logger.info('Razorpay client initialised (live keys present)');
} else if (env.DEMO_MODE) {
  logger.warn('Razorpay keys absent - running in DEMO payment mode. No real money moves.');
}

function isDemoPayments() {
  return !env.RAZORPAY_ENABLED && env.DEMO_MODE;
}

/**
 * Creates (or reuses) a payment intent for an order the caller owns.
 */
async function createPaymentForOrder(orderId, user) {
  const order = await orderService.getAuthorizedOrder(orderId, user);

  if (order.customerId !== user.id && user.role !== 'ADMIN') {
    throw ApiError.forbidden('You can only pay for your own orders.');
  }
  if (order.paymentMethod === 'CASH_ON_DELIVERY') {
    throw ApiError.badRequest('This order is set to cash on delivery.');
  }
  if (['CANCELLED', 'DELIVERED', 'FAILED'].includes(order.status)) {
    throw ApiError.conflict(`Order is ${order.status} and cannot be paid for.`);
  }

  const alreadyPaid = await prisma.payment.findFirst({
    where: { orderId: order.id, status: 'PAID' },
  });
  if (alreadyPaid) throw ApiError.conflict('This order has already been paid for.');

  // Amount is derived from the order, which was priced from the catalog.
  const amountInPaise = order.totalInPaise;

  // Reuse an outstanding intent rather than piling up Razorpay orders.
  const existing = await prisma.payment.findFirst({
    where: { orderId: order.id, status: 'CREATED', amountInPaise },
    orderBy: { createdAt: 'desc' },
  });
  if (existing && existing.providerOrderId) {
    return {
      paymentId: existing.id,
      providerOrderId: existing.providerOrderId,
      amountInPaise,
      currency: existing.currency,
      keyId: env.RAZORPAY_KEY_ID || null,
      isDemo: existing.isDemo,
      orderNumber: order.orderNumber,
    };
  }

  if (isDemoPayments()) {
    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        amountInPaise,
        provider: 'demo',
        providerOrderId: `demo_order_${crypto.randomBytes(8).toString('hex')}`,
        status: 'CREATED',
        isDemo: true,
      },
    });
    return {
      paymentId: payment.id,
      providerOrderId: payment.providerOrderId,
      amountInPaise,
      currency: 'INR',
      keyId: null,
      isDemo: true,
      orderNumber: order.orderNumber,
    };
  }

  if (!client) {
    throw ApiError.unavailable('Online payment is not configured. Please contact support.');
  }

  let rzpOrder;
  try {
    rzpOrder = await client.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: order.orderNumber,
      notes: { orderId: order.id, orderNumber: order.orderNumber },
    });
  } catch (err) {
    logger.error(`Razorpay order creation failed for ${order.orderNumber}: ${err.message}`);
    throw ApiError.unavailable('Could not reach the payment gateway. Please try again.');
  }

  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      amountInPaise,
      provider: 'razorpay',
      providerOrderId: rzpOrder.id,
      status: 'CREATED',
      isDemo: false,
    },
  });

  return {
    paymentId: payment.id,
    providerOrderId: rzpOrder.id,
    amountInPaise,
    currency: 'INR',
    // Publishable key only. The secret never goes to a client.
    keyId: env.RAZORPAY_KEY_ID,
    isDemo: false,
    orderNumber: order.orderNumber,
  };
}

function verifySignature(providerOrderId, providerPaymentId, signature) {
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${providerOrderId}|${providerPaymentId}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verifies a completed checkout and confirms the order.
 * Idempotent: calling it twice with the same payment returns the same result.
 */
async function verifyPayment({ providerOrderId, providerPaymentId, signature }, user) {
  const payment = await prisma.payment.findUnique({
    where: { providerOrderId },
    include: { order: true },
  });
  if (!payment) throw ApiError.notFound('Unknown payment reference.');

  // Ownership: a customer may only settle their own order.
  if (user.role !== 'ADMIN' && payment.order.customerId !== user.id) {
    throw ApiError.forbidden('That payment does not belong to you.');
  }

  // Idempotency guard.
  if (payment.status === 'PAID') {
    return { alreadyProcessed: true, paymentId: payment.id, orderId: payment.orderId, status: 'PAID' };
  }

  if (payment.isDemo) {
    if (!isDemoPayments()) {
      throw ApiError.forbidden('Demo payments are disabled.');
    }
    return finalisePayment(payment, `demo_pay_${crypto.randomBytes(8).toString('hex')}`, 'demo-signature');
  }

  if (!env.RAZORPAY_ENABLED) {
    throw ApiError.unavailable('Payment verification is not configured.');
  }
  if (!providerPaymentId || !signature) {
    throw ApiError.badRequest('Payment id and signature are required.');
  }

  if (!verifySignature(providerOrderId, providerPaymentId, signature)) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'FAILED', failureReason: 'Signature verification failed' },
    });
    await markOrderPaymentFailed(payment.orderId, 'Signature verification failed');
    throw ApiError.badRequest('Payment could not be verified.');
  }

  return finalisePayment(payment, providerPaymentId, signature);
}

async function finalisePayment(payment, providerPaymentId, signature) {
  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { status: 'PAID', providerPaymentId, signature, paidAt: new Date() },
    include: { order: true },
  });

  // Payment success confirms the order. SYSTEM is the actor - not the customer,
  // who is never allowed to drive this transition directly.
  const order = await prisma.order.findUnique({ where: { id: payment.orderId } });
  if (order && ['PENDING', 'PAYMENT_FAILED'].includes(order.status)) {
    await orderService.transitionOrder({
      orderId: order.id,
      to: 'CONFIRMED',
      actorRole: 'SYSTEM',
      note: updated.isDemo ? 'Confirmed by simulated demo payment' : 'Payment received',
    });
  }

  await notifications.notifyPayment(updated.order, true);

  return {
    alreadyProcessed: false,
    paymentId: updated.id,
    orderId: updated.orderId,
    status: 'PAID',
    isDemo: updated.isDemo,
  };
}

async function markPaymentFailed({ providerOrderId, reason }, user) {
  const payment = await prisma.payment.findUnique({
    where: { providerOrderId },
    include: { order: true },
  });
  if (!payment) throw ApiError.notFound('Unknown payment reference.');
  if (user.role !== 'ADMIN' && payment.order.customerId !== user.id) {
    throw ApiError.forbidden();
  }
  if (payment.status === 'PAID') {
    throw ApiError.conflict('That payment has already succeeded.');
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: { status: 'FAILED', failureReason: String(reason || 'Cancelled at checkout').slice(0, 300) },
  });
  await markOrderPaymentFailed(payment.orderId, reason);
  await notifications.notifyPayment(payment.order, false, reason);
  return { orderId: payment.orderId, status: 'FAILED' };
}

async function markOrderPaymentFailed(orderId, reason) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (!order || order.status !== 'PENDING') return;
  try {
    await orderService.transitionOrder({
      orderId,
      to: 'PAYMENT_FAILED',
      actorRole: 'SYSTEM',
      note: String(reason || 'Payment failed').slice(0, 300),
    });
  } catch (err) {
    logger.warn(`Could not move order ${orderId} to PAYMENT_FAILED: ${err.message}`);
  }
}

/**
 * Razorpay webhook. Independent of the browser callback, so a customer who
 * closes the tab mid-payment still gets a confirmed order.
 */
async function handleWebhook(rawBody, signatureHeader) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw ApiError.unavailable('Webhooks are not configured.');

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader || ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw ApiError.badRequest('Invalid webhook signature.');
  }

  const event = JSON.parse(rawBody.toString('utf8'));
  const entity = event.payload && event.payload.payment && event.payload.payment.entity;
  if (!entity) return { ignored: true };

  const payment = await prisma.payment.findUnique({
    where: { providerOrderId: entity.order_id },
    include: { order: true },
  });
  if (!payment || payment.status === 'PAID') return { ignored: true };

  if (event.event === 'payment.captured') {
    await finalisePayment(payment, entity.id, 'webhook');
    return { handled: 'payment.captured' };
  }
  if (event.event === 'payment.failed') {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'FAILED', failureReason: (entity.error_description || 'Failed').slice(0, 300) },
    });
    await markOrderPaymentFailed(payment.orderId, entity.error_description);
    return { handled: 'payment.failed' };
  }
  return { ignored: true };
}

module.exports = {
  createPaymentForOrder,
  verifyPayment,
  markPaymentFailed,
  handleWebhook,
  verifySignature,
  isDemoPayments,
};
