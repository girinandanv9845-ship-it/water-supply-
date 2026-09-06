'use strict';

const crypto = require('crypto');
const { prisma } = require('../config/db');
const { env } = require('../config/env');
const sms = require('./sms.service');
const email = require('./email.service');
const logger = require('../utils/logger');

/**
 * Passwordless login by one-time code, over SMS or email.
 *
 * The code itself is never stored - only a salted SHA-256 hash, compared in
 * constant time. Codes are single-use, attempt-limited and expiring.
 *
 * `identifier` is the phone number or email address the code was sent to, and
 * `channel` says which. Both paths share the same storage and verification, so
 * there is one place where login can go wrong rather than two.
 */

const CHANNEL = { SMS: 'SMS', EMAIL: 'EMAIL' };

function hashCode(identifier, code) {
  return crypto
    .createHash('sha256')
    .update(`${identifier}:${code}:${env.JWT_SECRET}`)
    .digest('hex');
}

function generateCode() {
  // 6 digits, cryptographically random, no leading-zero bias.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function maskIdentifier(identifier, channel) {
  return channel === CHANNEL.EMAIL ? email.maskEmail(identifier) : sms.maskPhone(identifier);
}

/**
 * Delivers the code over the requested channel.
 *
 * A configured provider always wins: the moment a real gateway exists the code
 * goes to the customer and is never returned to the browser or written to the
 * log, even with DEMO_MODE=true. The on-screen fallback exists only so the app
 * is usable before any gateway is set up, and is impossible in production.
 */
async function deliverCode(identifier, code, channel) {
  const provider = channel === CHANNEL.EMAIL ? email : sms;
  const label = channel === CHANNEL.EMAIL ? 'email' : 'SMS';

  if (provider.isConfigured()) {
    const result = await provider.sendOtp(identifier, code, env.OTP_TTL_SECONDS);
    if (result.sent) {
      return { sent: true, channel, provider: result.provider, exposeCode: false };
    }
    // Never silently fall back to an on-screen code - that would turn a
    // provider outage into an authentication bypass.
    return {
      sent: false,
      channel,
      provider: result.provider,
      error: result.error,
      exposeCode: false,
    };
  }

  if (env.DEMO_MODE) {
    logger.warn(
      `[DEMO MODE] No ${label} provider configured. OTP for ${maskIdentifier(identifier, channel)} ` +
        `is ${code} - configure one to send real messages.`
    );
    return { sent: true, channel: 'DEMO', requestedChannel: channel, exposeCode: true };
  }

  logger.error(`No ${label} provider configured and DEMO_MODE is off - OTP cannot be delivered.`);
  return { sent: false, channel: 'NONE', requestedChannel: channel, exposeCode: false };
}

/**
 * @param {string} identifier phone number or email address
 * @param {'SMS'|'EMAIL'} channel
 */
async function requestOtp(identifier, channel = CHANNEL.SMS, purpose = 'LOGIN') {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + env.OTP_TTL_SECONDS * 1000);

  // Invalidate any outstanding challenge so only the newest code works.
  await prisma.otpChallenge.updateMany({
    where: { identifier, purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  await prisma.otpChallenge.create({
    data: { identifier, channel, purpose, codeHash: hashCode(identifier, code), expiresAt },
  });

  const delivery = await deliverCode(identifier, code, channel);

  return {
    expiresInSeconds: env.OTP_TTL_SECONDS,
    channel: delivery.channel,
    delivered: delivery.sent,
    provider: delivery.provider,
    error: delivery.error,
    // Gated on how the code was actually delivered, NOT on DEMO_MODE. With a
    // real provider configured the code exists only on the customer's device,
    // even in development.
    demoCode: delivery.exposeCode ? code : undefined,
  };
}

/**
 * @returns {{ ok: boolean, reason?: string }}
 */
async function verifyOtp(identifier, code, purpose = 'LOGIN') {
  const challenge = await prisma.otpChallenge.findFirst({
    where: { identifier, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!challenge) return { ok: false, reason: 'Request a new code first.' };

  if (challenge.expiresAt < new Date()) {
    return { ok: false, reason: 'That code has expired. Request a new one.' };
  }

  if (challenge.attempts >= env.OTP_MAX_ATTEMPTS) {
    await prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
    return { ok: false, reason: 'Too many incorrect attempts. Request a new code.' };
  }

  if (!timingSafeEqual(challenge.codeHash, hashCode(identifier, String(code)))) {
    await prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
    });
    const left = env.OTP_MAX_ATTEMPTS - (challenge.attempts + 1);
    return {
      ok: false,
      reason: left > 0 ? `Incorrect code. ${left} attempt(s) left.` : 'Incorrect code.',
    };
  }

  await prisma.otpChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: new Date() },
  });
  return { ok: true, channel: challenge.channel };
}

/** Housekeeping so the table does not grow without bound. */
async function purgeExpiredOtps() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { count } = await prisma.otpChallenge.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (count) logger.debug(`Purged ${count} expired OTP challenges`);
  } catch (err) {
    logger.warn(`OTP purge failed: ${err.message}`);
  }
}

/** True when at least one delivery channel can actually reach a customer. */
function anyChannelConfigured() {
  return sms.isConfigured() || email.isConfigured();
}

module.exports = {
  CHANNEL,
  requestOtp,
  verifyOtp,
  purgeExpiredOtps,
  generateCode,
  anyChannelConfigured,
  maskIdentifier,
};
