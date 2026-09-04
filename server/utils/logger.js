'use strict';

/**
 * Minimal structured logger with secret redaction.
 * Anything that looks like a key/token/password is masked before it reaches
 * stdout, so logs are safe to ship to a hosting provider's log drain.
 */

const SECRET_KEYS = /(password|passwordhash|secret|token|authorization|apikey|api_key|signature|codehash|jwt|key_secret)/i;

function redact(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level, message, meta) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: typeof message === 'string' ? message : redact(message),
  };
  if (meta !== undefined) line.meta = redact(meta);

  const text =
    process.env.LOG_FORMAT === 'json'
      ? JSON.stringify(line)
      : `${line.ts} [${level.toUpperCase()}] ${line.msg}${meta !== undefined ? ` ${JSON.stringify(line.meta)}` : ''}`;

  if (level === 'error') process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
}

module.exports = {
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  debug: (msg, meta) => {
    if (process.env.LOG_LEVEL === 'debug') emit('debug', msg, meta);
  },
  redact,
};
