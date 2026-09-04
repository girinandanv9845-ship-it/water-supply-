'use strict';

const bcrypt = require('bcryptjs');
const { prisma } = require('../config/db');
const { env } = require('../config/env');
const { ApiError, ok, asyncHandler } = require('../utils/apiResponse');
const { signToken } = require('../middleware/auth');
const otpService = require('../services/otp.service');

const COOKIE_NAME = 'aquaflow_token';

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.IS_PROD,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    role: user.role,
    driverProfileId: user.driverProfile ? user.driverProfile.id : undefined,
  };
}

/** POST /api/auth/otp/request */
const requestOtp = asyncHandler(async (req, res) => {
  const { phone } = req.body;
  const result = await otpService.requestOtp(phone);

  if (!result.delivered) {
    throw ApiError.unavailable('We could not send the code right now. Please try again shortly.');
  }

  const existing = await prisma.user.findUnique({ where: { phone }, select: { id: true, name: true } });

  return ok(res, {
    phone,
    isNewUser: !existing,
    expiresInSeconds: result.expiresInSeconds,
    channel: result.channel,
    demoMode: env.DEMO_MODE,
    // Present only in demo mode - env.js guarantees this is never true in prod.
    demoCode: result.demoCode,
  });
});

/** POST /api/auth/otp/verify - signs in, creating the customer on first use. */
const verifyOtp = asyncHandler(async (req, res) => {
  const { phone, code, name } = req.body;

  const result = await otpService.verifyOtp(phone, code);
  if (!result.ok) throw ApiError.badRequest(result.reason);

  let user = await prisma.user.findUnique({
    where: { phone },
    include: { driverProfile: { select: { id: true } } },
  });

  if (!user) {
    if (!name) {
      throw ApiError.badRequest('Please tell us your name to finish creating your account.', [
        { field: 'name', message: 'Name is required for a new account.' },
      ]);
    }
    // Role is assigned by the server. A client cannot request DRIVER or ADMIN.
    user = await prisma.user.create({
      data: { phone, name, role: 'CUSTOMER' },
      include: { driverProfile: { select: { id: true } } },
    });
  } else if (!user.isActive) {
    throw ApiError.forbidden('This account has been deactivated. Please contact support.');
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, cookieOptions());
  return ok(res, { token, user: publicUser(user) });
});

/** POST /api/auth/admin/login - password login, ADMIN accounts only. */
const adminLogin = asyncHandler(async (req, res) => {
  const { phone, password } = req.body;

  const user = await prisma.user.findUnique({
    where: { phone },
    include: { driverProfile: { select: { id: true } } },
  });

  // Uniform failure message and a dummy hash comparison: no user enumeration,
  // no timing signal distinguishing "no such admin" from "wrong password".
  const hash = user && user.passwordHash ? user.passwordHash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu';
  const passwordOk = await bcrypt.compare(password, hash);

  if (!user || !passwordOk || user.role !== 'ADMIN' || !user.isActive) {
    throw ApiError.unauthorized('Invalid credentials.');
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, cookieOptions());
  return ok(res, { token, user: publicUser(user) });
});

/** GET /api/auth/me */
const me = asyncHandler(async (req, res) => ok(res, { user: publicUser(req.user) }));

/** POST /api/auth/logout */
const logout = asyncHandler(async (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  return ok(res, { loggedOut: true });
});

/** PATCH /api/auth/me */
const updateProfile = asyncHandler(async (req, res) => {
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { name: req.body.name, email: req.body.email || null },
    include: { driverProfile: { select: { id: true } } },
  });
  return ok(res, { user: publicUser(user) });
});

module.exports = { requestOtp, verifyOtp, adminLogin, me, logout, updateProfile, publicUser, COOKIE_NAME };
