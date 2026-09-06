'use strict';

const { z } = require('zod');
const { ApiError } = require('../utils/apiResponse');

/**
 * Validates and REPLACES req.body / req.query / req.params with the parsed
 * result, so handlers can never accidentally read an unvalidated extra field
 * (e.g. a client-supplied `price` or `role`).
 */
function validate(schemas) {
  return (req, res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
      if (schemas.query) req.validatedQuery = schemas.query.parse(req.query ?? {});
      if (schemas.params) req.params = schemas.params.parse(req.params ?? {});
      return next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        const details = err.issues.map((i) => ({
          field: i.path.join('.') || '(root)',
          message: i.message,
        }));
        return next(ApiError.badRequest('Some fields need attention.', details));
      }
      return next(err);
    }
  };
}

/* ---------- shared primitives ---------- */

const trimmed = (max) => z.string().trim().max(max);

/**
 * Indian mobile numbers, normalised to bare 10 digits.
 *
 * A country/trunk prefix is stripped ONLY when exactly 10 digits remain.
 * Stripping unconditionally would corrupt real numbers: "9123456789" is a valid
 * subscriber number, and a blind /^91/ strip would turn it into "23456789".
 */
const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s\-()]/g, ''))
  .transform((v) => {
    if (/^\+91\d{10}$/.test(v)) return v.slice(3);
    if (/^91\d{10}$/.test(v)) return v.slice(2);
    if (/^0\d{10}$/.test(v)) return v.slice(1);
    return v;
  })
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number.'));

// Lowercased and trimmed so "User@Gmail.com" and "user@gmail.com" are one account.
const email = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address.')
  .max(200);

const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);
const cuid = z.string().trim().min(1).max(64);

const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Login identity: exactly one of phone or email.
 * Refusing both prevents an ambiguous request where the two point at different
 * accounts and the server has to guess which one is being authenticated.
 */
function identitySchema(extra) {
  return z
    .object(Object.assign({ phone: phone.optional(), email: email.optional() }, extra || {}))
    .refine((d) => Boolean(d.phone) !== Boolean(d.email), {
      message: 'Provide either a mobile number or an email address.',
      path: ['phone'],
    });
}

module.exports = {
  validate,
  z,
  identitySchema,
  fields: { trimmed, phone, email, latitude, longitude, cuid, pagination },
};
