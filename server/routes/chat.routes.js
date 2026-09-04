'use strict';

const express = require('express');
const { prisma } = require('../config/db');
const { ok, asyncHandler } = require('../utils/apiResponse');
const { optionalAuth } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { chatLimiter } = require('../middleware/rateLimit');
const aiService = require('../services/ai.service');
const businessInfoService = require('../services/businessInfo.service');
const orderService = require('../services/order.service');
const fsm = require('../utils/orderStateMachine');

const router = express.Router();

/**
 * Builds the order context the assistant may speak about.
 *
 * Authorization is the whole point of this function: it reads ONLY orders whose
 * customerId is the signed-in user. A signed-out visitor gets null, so the bot
 * can never surface someone else's delivery.
 */
async function buildOrderContext(user) {
  if (!user || user.role !== 'CUSTOMER') return null;

  const orders = await prisma.order.findMany({
    where: { customerId: user.id },
    include: orderService.ORDER_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 3,
  });
  if (orders.length === 0) return null;

  const views = orders.map((o) => orderService.serializeOrder(o, { viewerRole: 'CUSTOMER' }));
  const activeView = views.find((v) => !v.isTerminal);

  const data = {
    customerName: user.name,
    activeOrder: activeView
      ? {
          orderNumber: activeView.orderNumber,
          status: activeView.status,
          statusMeaning: activeView.statusLabel,
          load: activeView.loadType,
          litres: activeView.quantityL,
          totalRupees: activeView.totalRupees,
          paymentStatus: activeView.paymentStatus,
          deliveryAddress: activeView.deliveryAddressText,
          driverName: activeView.driver ? activeView.driver.name : null,
          etaMinutes: activeView.etaMinutes,
          distanceKm: activeView.distanceKm,
          canCancel: activeView.canCancel,
          placedAt: activeView.createdAt,
        }
      : null,
    recentOrders: views.map((v) => ({
      orderNumber: v.orderNumber,
      status: v.status,
      load: v.loadType,
      totalRupees: v.totalRupees,
      placedAt: v.createdAt,
    })),
  };

  // Pre-written summary the rule-based fallback can use verbatim.
  let summary;
  if (!activeView) {
    summary = `You have no active orders right now. Your most recent order ${views[0].orderNumber} is ${fsm.CUSTOMER_LABELS[views[0].status] || views[0].status}.`;
  } else if (activeView.etaMinutes) {
    summary = `Your order ${activeView.orderNumber} is ${activeView.statusLabel.toLowerCase()}. The tanker is about ${activeView.distanceKm} km away, roughly ${activeView.etaMinutes} minutes.`;
  } else {
    summary = `Your order ${activeView.orderNumber} (${activeView.loadType}, ${activeView.quantityL}L) is currently: ${activeView.statusLabel}.`;
  }

  return { data, summary };
}

/**
 * POST /api/chat
 * Works signed-out (general FAQ) and signed-in (order-aware).
 */
router.post(
  '/',
  optionalAuth,
  chatLimiter,
  validate({
    body: z.object({
      message: fields.trimmed(1000).min(1),
      conversationId: fields.cuid.optional(),
      // Client-supplied history is capped and only used for conversational flow.
      history: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: fields.trimmed(2000),
          })
        )
        .max(10)
        .optional()
        .default([]),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { message, history, conversationId } = req.body;

    const [businessInfo, orderContext] = await Promise.all([
      businessInfoService.getBusinessInfo(),
      buildOrderContext(req.user),
    ]);

    const messages = [...history, { role: 'user', content: message }];
    const result = await aiService.chat({ messages, businessInfo, orderContext });

    // Persist the exchange so admins can review support quality.
    let conversation = null;
    try {
      if (conversationId) {
        conversation = await prisma.supportConversation.findUnique({ where: { id: conversationId } });
        // Never append to someone else's conversation.
        if (conversation && req.user && conversation.userId && conversation.userId !== req.user.id) {
          conversation = null;
        }
      }
      if (!conversation) {
        conversation = await prisma.supportConversation.create({
          data: { userId: req.user ? req.user.id : null, title: message.slice(0, 60) },
        });
      }
      await prisma.supportMessage.createMany({
        data: [
          { conversationId: conversation.id, role: 'user', content: message },
          { conversationId: conversation.id, role: 'assistant', content: result.text },
        ],
      });
      await prisma.supportConversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });
    } catch {
      // Chat must keep working even if transcript storage fails.
    }

    return ok(res, {
      reply: result.text,
      provider: result.provider,
      degraded: result.degraded,
      conversationId: conversation ? conversation.id : null,
      hasOrderContext: Boolean(orderContext),
    });
  })
);

/** GET /api/chat/history - the caller's own transcripts. */
router.get(
  '/history',
  optionalAuth,
  asyncHandler(async (req, res) => {
    if (!req.user) return ok(res, []);
    const conversations = await prisma.supportConversation.findMany({
      where: { userId: req.user.id },
      include: { messages: { orderBy: { createdAt: 'asc' }, take: 100 } },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });
    return ok(res, conversations);
  })
);

module.exports = router;
