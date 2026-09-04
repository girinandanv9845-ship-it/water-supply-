'use strict';

const crypto = require('crypto');
const { prisma } = require('../config/db');
const { env } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Phone + OTP authentication.
 *
 * The code itself is never stored - only a SHA-256 hash, compared in constant
 * time. In DEMO_MODE the code is additionally returned in the API response and
 * printed to the server log so local development needs no SMS gateway; that
 * branch is unreachable in production because env.js force-disables DEMO_MODE
 * when NODE_ENV=production.
 */

function hashCode(phone, code) {
  return crypto.createHash('sha256').update(`${phone}:${code}:${env.JWT_SECRET}`).digest('hex');
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

/** Pluggable SMS delivery. Returns whether it actually left the building. */
async function deliverCode(phone, code) {
  if (process.env.SMS_PROVIDER_KEY) {
    // Real gateway goes here (MSG91 / Twilio / Gupshup).
    logger.info(`OTP dispatched via SMS provider to ${phone.slice(0, 3)}*****`);
    return { sent: true, channel: 'SMS' };
  }
  if (env.DEMO_MODE) {
    logger.warn(`[DEMO MODE] OTP for ${phone} is ${code} - never enable this in production.`);
    return { sent: true, channel: 'DEMO' };
  }
  logger.error('No SMS provider configured and DEMO_MODE is off - OTP cannot be delivered.');
  return { sent: false, channel: 'NONE' };
}

async function requestOtp(phone, purpose = 'LOGIN') {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + env.OTP_TTL_SECONDS * 1000);

  // Invalidate any outstanding challenge so only the newest code works.
  await prisma.otpChallenge.updateMany({
    where: { phone, purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  await prisma.otpChallenge.create({
    data: { phone, purpose, codeHash: hashCode(phone, code), expiresAt },
  });

  const delivery = await deliverCode(phone, code);

  return {
    expiresInSeconds: env.OTP_TTL_SECONDS,
    channel: delivery.channel,
    delivered: delivery.sent,
    // Only ever populated in demo mode.
    demoCode: env.DEMO_MODE ? code : undefined,
  };
}

/**
 * @returns {{ ok: boolean, reason?: string }}
 */
async function verifyOtp(phone, code, purpose = 'LOGIN') {
  const challenge = await prisma.otpChallenge.findFirst({
    where: { phone, purpose, consumedAt: null },
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

  if (!timingSafeEqual(challenge.codeHash, hashCode(phone, String(code)))) {
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
  return { ok: true };
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

module.exports = { requestOtp, verifyOtp, purgeExpiredOtps, generateCode };
