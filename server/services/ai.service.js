'use strict';

const { env } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Modular chat provider.
 *
 * Every provider implements: { name, isConfigured(), complete({system, messages}) }
 * Adding a provider means adding one object here - nothing else in the app
 * knows which LLM is behind the chatbot.
 *
 * The `fallback` provider is rule-based and always available, so the chat
 * feature degrades gracefully instead of erroring when no API key is set or the
 * upstream call fails.
 */

const providers = {};

/* ---------------- Anthropic ---------------- */

providers.anthropic = {
  name: 'anthropic',
  isConfigured: () => Boolean(env.AI_API_KEY),
  async complete({ system, messages }) {
    // Required lazily so the SDK is not a hard dependency when unused.
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: env.AI_API_KEY });

    const response = await client.messages.create({
      model: env.AI_MODEL || 'claude-opus-5',
      max_tokens: 1024,
      // A support bot should answer fast and cheaply; the knowledge is supplied
      // in the system prompt, so deep reasoning buys nothing here.
      output_config: { effort: 'low' },
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    if (response.stop_reason === 'refusal') {
      return { text: "I can't help with that one. Please contact our support team.", provider: 'anthropic' };
    }

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    return { text, provider: 'anthropic', usage: response.usage };
  },
};

/* ---------------- OpenAI-compatible ---------------- */

providers.openai = {
  name: 'openai',
  isConfigured: () => Boolean(env.AI_API_KEY),
  async complete({ system, messages }) {
    const base = process.env.AI_BASE_URL || 'https://api.openai.com/v1';
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.AI_MODEL || 'gpt-4o-mini',
        max_tokens: 1024,
        messages: [{ role: 'system', content: system }, ...messages],
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`AI provider responded ${res.status}: ${detail.slice(0, 200)}`);
    }
    const json = await res.json();
    return { text: json.choices[0].message.content.trim(), provider: 'openai' };
  },
};

/* ---------------- Rule-based fallback ---------------- */

function formatProducts(info) {
  if (!info.products || info.products.length === 0) return null;
  return info.products
    .map((p) => `- ${p.name}: ${p.litres} litres for Rs ${p.priceRupees}`)
    .join('\n');
}

/**
 * Deterministic keyword answers drawn strictly from businessInfo. Used when no
 * AI provider is configured, and as the safety net when one fails.
 */
function ruleBasedAnswer(question, info, orderContext) {
  const q = String(question || '').toLowerCase();

  const has = (...words) => words.some((w) => q.includes(w));

  if (orderContext && has('where', 'track', 'status', 'how long', 'eta', 'arriv', 'my order', 'tanker')) {
    return orderContext.summary;
  }

  if (has('price', 'cost', 'rate', 'charge', 'how much')) {
    const list = formatProducts(info);
    return list
      ? `Here are our current rates:\n${list}\n\nYou can book any of these from the home screen.`
      : "I don't have pricing information available right now. Please contact support.";
  }

  if (has('book', 'order water', 'place an order', 'how do i order')) {
    return 'To book: open the home screen, pick a water load, choose or pin your delivery address on the map, then confirm and pay. You can track the tanker live once a driver is assigned.';
  }

  if (has('quantity', 'litre', 'liter', 'capacity', 'how much water')) {
    const list = formatProducts(info);
    return list ? `We deliver these load sizes:\n${list}` : "I don't have load information available right now.";
  }

  if (has('cancel', 'refund')) {
    return `${info.cancellationPolicy}${info.refundPolicy ? `\n\n${info.refundPolicy}` : ''}`;
  }

  if (has('pay', 'payment', 'upi', 'card', 'cash')) {
    return `We accept: ${(info.paymentMethods || []).join(', ')}.`;
  }

  if (has('area', 'deliver to', 'location', 'pincode', 'serviceable')) {
    if (info.serviceAreas && info.serviceAreas.length) {
      return `We currently serve: ${info.serviceAreas.map((a) => a.name).join(', ')}. Enter your address at checkout and the app will confirm whether we reach you.`;
    }
    return "I don't have our service area list available. Please contact support to confirm coverage.";
  }

  if (has('time', 'hour', 'open', 'when')) {
    return `Our working hours are ${info.workingHours}. ${info.deliveryTimeNote || ''}`.trim();
  }

  if (has('contact', 'support', 'phone', 'call', 'help')) {
    return info.supportPhone
      ? `You can reach our support team on ${info.supportPhone}${info.supportEmail ? ` or ${info.supportEmail}` : ''}.`
      : "I don't have a support number on file. Please use the contact option in the app.";
  }

  if (has('hi', 'hello', 'hey')) {
    return `Hello! I'm the ${info.companyName} assistant. I can help with booking water, prices, order status, payments and cancellations.`;
  }

  return "I don't have that information. Please contact support and someone from our team will help you.";
}

providers.fallback = {
  name: 'fallback',
  isConfigured: () => true,
  async complete({ messages, businessInfo, orderContext }) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    return {
      text: ruleBasedAnswer(lastUser && lastUser.content, businessInfo, orderContext),
      provider: 'fallback',
    };
  },
};

/* ---------------- Prompt construction ---------------- */

/**
 * The system prompt pins the model to the supplied facts. Anything not present
 * must produce the "I don't have that information" answer rather than a guess -
 * a chatbot inventing a delivery time or a refund policy is a real business risk.
 */
function buildSystemPrompt(businessInfo, orderContext) {
  const lines = [
    `You are the customer support assistant for ${businessInfo.companyName}, a water tanker delivery service.`,
    '',
    'STRICT RULES:',
    '1. Answer ONLY from the BUSINESS FACTS and CUSTOMER ORDER CONTEXT below, plus ordinary conversational help.',
    '2. Never invent prices, delivery times, policies, service areas, phone numbers or availability.',
    '3. If the answer is not in the facts below, reply exactly: "I don\'t have that information. Please contact support."',
    '4. Never mention another customer or any order that is not in the context below.',
    '5. Keep replies short and practical - two or three sentences unless asked for detail.',
    '6. Amounts are Indian Rupees (Rs).',
    '',
    'BUSINESS FACTS:',
    JSON.stringify(
      {
        companyName: businessInfo.companyName,
        workingHours: businessInfo.workingHours,
        supportPhone: businessInfo.supportPhone || null,
        supportEmail: businessInfo.supportEmail || null,
        paymentMethods: businessInfo.paymentMethods,
        cancellationPolicy: businessInfo.cancellationPolicy,
        refundPolicy: businessInfo.refundPolicy,
        deliveryTimeNote: businessInfo.deliveryTimeNote,
        waterSource: businessInfo.waterSource,
        availableLoads: businessInfo.products,
        serviceAreas: businessInfo.serviceAreas,
        extraNotes: businessInfo.notes || null,
      },
      null,
      2
    ),
    '',
  ];

  if (orderContext) {
    lines.push(
      "CUSTOMER ORDER CONTEXT (this signed-in customer's own orders only):",
      JSON.stringify(orderContext.data, null, 2),
      ''
    );
  } else {
    lines.push(
      'CUSTOMER ORDER CONTEXT: none. The user is not signed in or has no recent orders.',
      'If they ask about a specific order, tell them to sign in and open the order from their orders list.',
      ''
    );
  }

  return lines.join('\n');
}

/**
 * Main entry point. Always resolves - a provider failure downgrades to the
 * rule-based answer rather than surfacing an error to the customer.
 */
async function chat({ messages, businessInfo, orderContext }) {
  const system = buildSystemPrompt(businessInfo, orderContext);
  const providerName = env.AI_PROVIDER;
  const provider = providers[providerName];

  if (!provider || !provider.isConfigured()) {
    const result = await providers.fallback.complete({ messages, businessInfo, orderContext });
    return { ...result, degraded: providerName !== 'none' };
  }

  try {
    const result = await provider.complete({ system, messages, businessInfo, orderContext });
    if (!result.text) throw new Error('Empty response from AI provider');
    return { ...result, degraded: false };
  } catch (err) {
    logger.error(`AI provider "${providerName}" failed: ${err.message}`);
    const result = await providers.fallback.complete({ messages, businessInfo, orderContext });
    return { ...result, degraded: true };
  }
}

module.exports = { chat, providers, buildSystemPrompt, ruleBasedAnswer };
