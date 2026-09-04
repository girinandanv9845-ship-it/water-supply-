'use strict';

const { ApiError } = require('../utils/apiResponse');
const { env } = require('../config/env');
const logger = require('../utils/logger');

function notFoundHandler(req, res) {
  return res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${req.originalUrl}` },
  });
}

/** Maps Prisma's error codes onto sensible HTTP responses. */
function mapPrismaError(err) {
  switch (err.code) {
    case 'P2002': {
      const target = Array.isArray(err.meta && err.meta.target)
        ? err.meta.target.join(', ')
        : 'field';
      return ApiError.conflict(`That ${target} is already in use.`);
    }
    case 'P2025':
      return ApiError.notFound('The requested record no longer exists.');
    case 'P2003':
      return ApiError.badRequest('A referenced record does not exist.');
    case 'P1001':
    case 'P1002':
    case 'P1017':
      return ApiError.unavailable('The database is unreachable right now. Please try again in a moment.');
    default:
      return null;
  }
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let apiError = err;

  if (!(err instanceof ApiError)) {
    const mapped = err && err.code ? mapPrismaError(err) : null;
    if (mapped) {
      apiError = mapped;
    } else if (err && err.type === 'entity.parse.failed') {
      apiError = ApiError.badRequest('Request body is not valid JSON.');
    } else {
      apiError = new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong on our side.');
      apiError.expose = false;
    }
  }

  const level = apiError.status >= 500 ? 'error' : 'warn';
  logger[level](`${req.method} ${req.originalUrl} -> ${apiError.status} ${apiError.code}`, {
    message: err.message,
    userId: req.user && req.user.id,
    // Stack only on server-side faults, and never in production logs shipped elsewhere.
    stack: apiError.status >= 500 && !env.IS_PROD ? err.stack : undefined,
  });

  const body = {
    success: false,
    error: { code: apiError.code, message: apiError.message },
  };
  if (apiError.details) body.error.details = apiError.details;
  if (!env.IS_PROD && apiError.status >= 500) body.error.debug = err.message;

  return res.status(apiError.status || 500).json(body);
}

module.exports = { errorHandler, notFoundHandler };
