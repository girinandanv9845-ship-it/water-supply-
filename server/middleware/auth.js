'use strict';

const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { prisma } = require('../config/db');
const { ApiError } = require('../utils/apiResponse');

/**
 * Tokens carry only the user id. Role, active flag and driver profile are read
 * from the database on every request, so a revoked/demoted account loses access
 * immediately instead of when its token expires.
 */

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
    issuer: 'aquaflow',
  });
}

function verifyToken(token) {
  return jwt.verify(token, env.JWT_SECRET, { issuer: 'aquaflow' });
}

function extractToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  if (req.cookies && req.cookies.aquaflow_token) return req.cookies.aquaflow_token;
  return null;
}

/** Loads the user for a valid token. Returns null instead of throwing. */
async function resolveUser(token) {
  if (!token) return null;
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return null;
  }
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      role: true,
      isActive: true,
      driverProfile: { select: { id: true, status: true, isVerified: true } },
    },
  });
  if (!user || !user.isActive) return null;
  return user;
}

/** Hard gate - 401 when there is no valid session. */
async function requireAuth(req, res, next) {
  try {
    const user = await resolveUser(extractToken(req));
    if (!user) return next(ApiError.unauthorized('Please sign in to continue.'));
    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Populates req.user when a token is present, but never rejects. */
async function optionalAuth(req, res, next) {
  try {
    req.user = await resolveUser(extractToken(req));
  } catch {
    req.user = null;
  }
  return next();
}

/** Role gate. Use after requireAuth. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(ApiError.forbidden('Your account does not have access to this resource.'));
    }
    return next();
  };
}

/** Drivers additionally need a verified driver profile to work. */
function requireDriverProfile(req, res, next) {
  if (!req.user || req.user.role !== 'DRIVER') {
    return next(ApiError.forbidden('Driver access only.'));
  }
  if (!req.user.driverProfile) {
    return next(ApiError.forbidden('No driver profile is linked to this account.'));
  }
  if (!req.user.driverProfile.isVerified) {
    return next(ApiError.forbidden('Your driver account is pending verification by an admin.'));
  }
  req.driverProfileId = req.user.driverProfile.id;
  return next();
}

module.exports = {
  signToken,
  verifyToken,
  resolveUser,
  extractToken,
  requireAuth,
  optionalAuth,
  requireRole,
  requireDriverProfile,
};
