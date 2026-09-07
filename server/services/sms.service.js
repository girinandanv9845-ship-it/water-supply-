'use strict';

const logger = require('../utils/logger');

/**
 * SMS delivery.
 *
 * Each provider is `{ name, isConfigured(), send({ phone, message, code }) }`
 * and resolves `{ sent, channel, id?, error? }`. Adding a gateway means adding
 * one object here; nothing else in the app changes.
 *
 * `SMS_PROVIDER` picks one explicitly. Left unset, the first configured
 * provider wins, so setting credentials is enough to switch a deployment from
 * on-screen demo codes to real SMS.
 *
 * Indian numbers are stored as bare 10 digits; providers that need E.164 get
 * +91 prefixed at the edge.
 */

const COUNTRY_CODE = process.env.SMS_COUNTRY_CODE || '91';

function e164(phone) {
  return '+' + COUNTRY_CODE + phone;
}
function withCountry(phone) {
  return COUNTRY_CODE + phone;
}
function maskPhone(phone) {
  return phone.slice(0, 3) + '*****' + phone.slice(-2);
}

/** 12s ceiling: a customer is staring at a spinner while this runs. */
async function postJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.SMS_TIMEOUT_MS) || 12000);
  try {
    const res = await fetch(url, Object.assign({ signal: controller.signal }, options));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* some gateways reply in plain text */ }
    return { ok: res.ok, status: res.status, text: text, json: json };
  } finally {
    clearTimeout(timer);
  }
}

const providers = {};

/* ------------------------------------------------------------------ *
 * MSG91 - the usual choice for Indian transactional SMS.
 * Its OTP endpoint handles DLT template variables for you.
 * ------------------------------------------------------------------ */
providers.msg91 = {
  name: 'msg91',
  isConfigured: () => Boolean(process.env.MSG91_AUTH_KEY && process.env.MSG91_TEMPLATE_ID),
  async send({ phone, code }) {
    const body = {
      template_id: process.env.MSG91_TEMPLATE_ID,
      recipients: [
        {
          mobiles: withCountry(phone),
          // Must match the variable names in your approved DLT template.
          OTP: code,
          otp: code,
          COMPANY: process.env.SMS_SENDER_NAME || 'AquaFlow',
        },
      ],
    };
    if (process.env.MSG91_SENDER_ID) body.sender = process.env.MSG91_SENDER_ID;

    const res = await postJson('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authkey: process.env.MSG91_AUTH_KEY,
      },
      body: JSON.stringify(body),
    });

    // MSG91 answers 200 with {type:"error"} on rejection, so status alone is not enough.
    const failed = !res.ok || (res.json && res.json.type === 'error');
    if (failed) {
      return { sent: false, channel: 'SMS', error: (res.json && res.json.message) || res.text.slice(0, 200) };
    }
    return { sent: true, channel: 'SMS', id: res.json && res.json.request_id };
  },
};

/* ------------------------------------------------------------------ *
 * Twilio - simplest to get running, but Indian delivery still needs DLT.
 * ------------------------------------------------------------------ */
providers.twilio = {
  name: 'twilio',
  isConfigured: () =>
    Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM),
  async send({ phone, message }) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = Buffer.from(sid + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
    const form = new URLSearchParams({
      To: e164(phone),
      From: process.env.TWILIO_FROM,
      Body: message,
    });

    const res = await postJson('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });

    if (!res.ok) {
      return { sent: false, channel: 'SMS', error: (res.json && res.json.message) || res.text.slice(0, 200) };
    }
    return { sent: true, channel: 'SMS', id: res.json && res.json.sid };
  },
};

/* ------------------------------------------------------------------ *
 * Fast2SMS - India only, no international support.
 * ------------------------------------------------------------------ */
providers.fast2sms = {
  name: 'fast2sms',
  isConfigured: () => Boolean(process.env.FAST2SMS_API_KEY),
  async send({ phone, code }) {
    const params = new URLSearchParams({
      route: 'dlt',
      sender_id: process.env.FAST2SMS_SENDER_ID || 'AQUAFL',
      message: process.env.FAST2SMS_MESSAGE_ID || '',
      variables_values: code,
      numbers: phone,
      flash: '0',
    });

    const res = await postJson('https://www.fast2sms.com/dev/bulkV2?' + params.toString(), {
      method: 'GET',
      headers: { authorization: process.env.FAST2SMS_API_KEY },
    });

    const failed = !res.ok || (res.json && res.json.return === false);
    if (failed) {
      return { sent: false, channel: 'SMS', error: (res.json && res.json.message) || res.text.slice(0, 200) };
    }
    return { sent: true, channel: 'SMS', id: res.json && res.json.request_id };
  },
};

/* ------------------------------------------------------------------ *
 * Generic webhook - POST the payload to any endpoint you control.
 * Use this for a gateway not listed above without touching this file.
 * ------------------------------------------------------------------ */
providers.webhook = {
  name: 'webhook',
  isConfigured: () => Boolean(process.env.SMS_WEBHOOK_URL),
  async send({ phone, message, code }) {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.SMS_WEBHOOK_TOKEN) {
      headers.Authorization = 'Bearer ' + process.env.SMS_WEBHOOK_TOKEN;
    }
    const res = await postJson(process.env.SMS_WEBHOOK_URL, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ to: e164(phone), message: message, code: code }),
    });
    if (!res.ok) return { sent: false, channel: 'SMS', error: res.text.slice(0, 200) };
    return { sent: true, channel: 'SMS' };
  },
};

/** Resolves the active provider, or null when none has credentials. */
function activeProvider() {
  const explicit = (process.env.SMS_PROVIDER || '').toLowerCase().trim();

  if (explicit && explicit !== 'none') {
    const p = providers[explicit];
    if (!p) {
      logger.error(
        'SMS_PROVIDER="' + explicit + '" is not recognised. Valid: ' + Object.keys(providers).join(', ')
      );
      return null;
    }
    if (!p.isConfigured()) {
      logger.error('SMS_PROVIDER="' + explicit + '" is selected but its credentials are missing.');
      return null;
    }
    return p;
  }

  // No explicit choice: use whichever is fully configured.
  const order = ['msg91', 'fast2sms', 'twilio', 'webhook'];
  for (const key of order) {
    if (providers[key].isConfigured()) return providers[key];
  }
  return null;
}

function isConfigured() {
  return activeProvider() !== null;
}

function providerName() {
  const p = activeProvider();
  return p ? p.name : null;
}

function buildOtpMessage(code, ttlSeconds) {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  const brand = process.env.SMS_SENDER_NAME || 'AquaFlow';
  return (
    process.env.SMS_OTP_TEMPLATE
      ? process.env.SMS_OTP_TEMPLATE.replace('{code}', code).replace('{minutes}', String(minutes))
      : `${code} is your ${brand} verification code. It expires in ${minutes} minutes. Do not share it with anyone.`
  );
}

/**
 * Sends an OTP. Never throws - a gateway outage becomes `{ sent: false }` so
 * the caller can return a clean error rather than a 500.
 */
async function sendOtp(phone, code, ttlSeconds) {
  const provider = activeProvider();
  if (!provider) return { sent: false, channel: 'NONE', error: 'No SMS provider configured' };

  const message = buildOtpMessage(code, ttlSeconds);
  try {
    const result = await provider.send({ phone, message, code });
    if (result.sent) {
      // The code itself is never logged on the real path.
      logger.info(`OTP sent via ${provider.name} to ${maskPhone(phone)}`, { id: result.id });
    } else {
      logger.error(`OTP send failed via ${provider.name} to ${maskPhone(phone)}: ${result.error}`);
    }
    return Object.assign({ provider: provider.name }, result);
  } catch (err) {
    const aborted = err.name === 'AbortError';
    logger.error(
      `OTP send threw via ${provider.name}: ${aborted ? 'gateway timed out' : err.message}`
    );
    return {
      sent: false,
      channel: 'SMS',
      provider: provider.name,
      error: aborted ? 'SMS gateway timed out' : err.message,
    };
  }
}

/**
 * Sends an arbitrary message (order updates, not login codes).
 * Never throws, for the same reason sendOtp does not.
 */
async function send(phone, message) {
  const provider = activeProvider();
  if (!provider) return { sent: false, error: 'No SMS provider configured' };
  try {
    // `code` is undefined here: template-based gateways (MSG91 flow, Fast2SMS
    // DLT) are built around OTP templates and will reject free text, so this
    // path is really only usable on Twilio or a webhook.
    const result = await provider.send({ phone, message });
    if (!result.sent) {
      logger.warn(`SMS to ${maskPhone(phone)} failed via ${provider.name}: ${result.error}`);
    }
    return Object.assign({ provider: provider.name }, result);
  } catch (err) {
    logger.warn(`SMS to ${maskPhone(phone)} threw via ${provider.name}: ${err.message}`);
    return { sent: false, provider: provider.name, error: err.message };
  }
}

module.exports = {
  providers,
  sendOtp,
  send,
  isConfigured,
  providerName,
  activeProvider,
  buildOtpMessage,
  maskPhone,
  e164,
};
