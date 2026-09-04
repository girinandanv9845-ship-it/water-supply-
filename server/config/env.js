'use strict';

/**
 * Central environment configuration.
 * Every secret in the app is read here and nowhere else, so there is exactly
 * one place to audit for hardcoded credentials.
 */

require('dotenv').config();

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// DEMO_MODE is force-disabled in production: mock OTP and simulated payments
// must never be reachable on a live deployment, whatever the .env says.
const demoRequested = bool(process.env.DEMO_MODE, !IS_PROD);
const DEMO_MODE = IS_PROD ? false : demoRequested;

const env = {
  NODE_ENV,
  IS_PROD,
  DEMO_MODE,
  DEMO_MODE_REQUESTED_IN_PROD: IS_PROD && demoRequested,

  PORT: int(process.env.PORT, 3000),
  DATABASE_URL: process.env.DATABASE_URL || '',

  JWT_SECRET: process.env.JWT_SECRET || '',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',

  CORS_ORIGINS: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || '',
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || '',

  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || '',

  AI_PROVIDER: (process.env.AI_PROVIDER || 'none').toLowerCase(),
  AI_API_KEY: process.env.AI_API_KEY || '',
  AI_MODEL: process.env.AI_MODEL || 'claude-opus-5',

  OTP_TTL_SECONDS: int(process.env.OTP_TTL_SECONDS, 300),
  OTP_MAX_ATTEMPTS: int(process.env.OTP_MAX_ATTEMPTS, 5),

  // Driver GPS throttle. The client also throttles; the server enforces it so a
  // misbehaving client cannot flood the socket layer.
  LOCATION_MIN_INTERVAL_MS: int(process.env.LOCATION_MIN_INTERVAL_MS, 3000),

  ADMIN_SEED_PHONE: process.env.ADMIN_SEED_PHONE || '9000000001',
  ADMIN_SEED_PASSWORD: process.env.ADMIN_SEED_PASSWORD || '',

  TRUST_PROXY: bool(process.env.TRUST_PROXY, false),
};

env.RAZORPAY_ENABLED = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
env.AI_ENABLED = env.AI_PROVIDER !== 'none' && Boolean(env.AI_API_KEY);
env.MAPS_ENABLED = Boolean(env.GOOGLE_MAPS_API_KEY);

/**
 * Fail fast on misconfiguration that would otherwise surface as a confusing
 * runtime error (or, worse, as a silent security hole in production).
 */
function validateEnv() {
  const errors = [];
  const warnings = [];

  if (!env.DATABASE_URL) {
    errors.push('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }

  if (!env.JWT_SECRET) {
    errors.push('JWT_SECRET is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  } else if (env.JWT_SECRET.length < 32) {
    errors.push('JWT_SECRET is too short - use at least 32 characters.');
  }

  if (IS_PROD) {
    if (demoRequested) {
      warnings.push('DEMO_MODE=true was ignored because NODE_ENV=production. Mock OTP and simulated payments are disabled.');
    }
    if (!env.RAZORPAY_ENABLED) {
      errors.push('Production requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
    }
    if (env.CORS_ORIGINS.length === 0) {
      errors.push('Production requires CORS_ORIGINS (comma-separated list of allowed origins).');
    }
  } else {
    if (!env.RAZORPAY_ENABLED) {
      warnings.push('Razorpay keys absent - payments run in DEMO mode and are clearly labelled as such.');
    }
    if (!env.AI_ENABLED) {
      warnings.push('AI_API_KEY absent - the support chatbot uses the offline rule-based knowledge base.');
    }
    if (!env.MAPS_ENABLED) {
      warnings.push('GOOGLE_MAPS_API_KEY absent - maps fall back to a coordinate picker without tiles.');
    }
  }

  return { errors, warnings };
}

module.exports = { env, validateEnv };
