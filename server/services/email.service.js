'use strict';

const logger = require('../utils/logger');

/**
 * Email delivery, mirroring sms.service so the OTP layer can treat the two
 * channels identically.
 *
 * Providers: `{ name, isConfigured(), send({ to, subject, text, html }) }`
 * resolving `{ sent, error? }`.
 *
 * Gmail is the zero-cost path and needs no DLT/TRAI registration, which is why
 * it is the recommended default for getting real codes to real people quickly.
 * It does require a Google App Password - a normal account password will be
 * rejected by Google.
 */

let transporter = null;
let transporterKey = '';

function maskEmail(email) {
  const at = String(email).indexOf('@');
  if (at < 1) return '***';
  const name = email.slice(0, at);
  const domain = email.slice(at);
  const head = name.slice(0, Math.min(2, name.length));
  return head + '*'.repeat(Math.max(1, name.length - head.length)) + domain;
}

/** Resolves SMTP settings, expanding the `gmail` shorthand. */
function smtpConfig() {
  const service = (process.env.EMAIL_PROVIDER || '').toLowerCase().trim();

  if (service === 'gmail' || process.env.GMAIL_USER) {
    const user = process.env.GMAIL_USER || process.env.SMTP_USER;
    const pass = process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS;
    if (!user || !pass) return null;
    return {
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass },
      from: process.env.EMAIL_FROM || `AquaFlow <${user}>`,
      label: 'gmail',
    };
  }

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const port = Number(process.env.SMTP_PORT) || 587;
    return {
      host: process.env.SMTP_HOST,
      port,
      // 465 is implicit TLS; 587 upgrades via STARTTLS.
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      from: process.env.EMAIL_FROM || `AquaFlow <${process.env.SMTP_USER}>`,
      label: 'smtp',
    };
  }

  return null;
}

const providers = {};

/* ---------------- SMTP (Gmail, Outlook, Zoho, Mailgun, SES, ...) ---------------- */
providers.smtp = {
  name: 'smtp',
  isConfigured: () => smtpConfig() !== null,
  async send({ to, subject, text, html }) {
    const cfg = smtpConfig();
    if (!cfg) return { sent: false, error: 'SMTP not configured' };

    // Cache the transporter, but rebuild it if the credentials change.
    const key = cfg.host + ':' + cfg.port + ':' + cfg.auth.user;
    if (!transporter || transporterKey !== key) {
      const nodemailer = require('nodemailer');
      transporter = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.auth,
        connectionTimeout: Number(process.env.EMAIL_TIMEOUT_MS) || 12000,
        greetingTimeout: 8000,
        socketTimeout: 15000,
      });
      transporterKey = key;
    }

    const info = await transporter.sendMail({ from: cfg.from, to, subject, text, html });
    return { sent: true, id: info.messageId };
  },
};

/* ---------------- Resend (HTTP API, no SMTP ports needed) ---------------- */
providers.resend = {
  name: 'resend',
  isConfigured: () => Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
  async send({ to, subject, text, html }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(process.env.EMAIL_TIMEOUT_MS) || 12000);
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        },
        body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text, html }),
      });
      const body = await res.text();
      if (!res.ok) return { sent: false, error: body.slice(0, 200) };
      let json = null;
      try { json = JSON.parse(body); } catch { /* ignore */ }
      return { sent: true, id: json && json.id };
    } finally {
      clearTimeout(timer);
    }
  },
};

/* ---------------- Generic webhook ---------------- */
providers.webhook = {
  name: 'email-webhook',
  isConfigured: () => Boolean(process.env.EMAIL_WEBHOOK_URL),
  async send({ to, subject, text }) {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.EMAIL_WEBHOOK_TOKEN) headers.Authorization = 'Bearer ' + process.env.EMAIL_WEBHOOK_TOKEN;
    const res = await fetch(process.env.EMAIL_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to, subject, message: text }),
    });
    if (!res.ok) return { sent: false, error: (await res.text()).slice(0, 200) };
    return { sent: true };
  },
};

function activeProvider() {
  const explicit = (process.env.EMAIL_PROVIDER || '').toLowerCase().trim();

  // `gmail` is a shorthand for the SMTP provider, not a separate one.
  if (explicit && explicit !== 'none') {
    const key = explicit === 'gmail' ? 'smtp' : explicit;
    const p = providers[key];
    if (!p) {
      logger.error(
        'EMAIL_PROVIDER="' + explicit + '" is not recognised. Valid: gmail, smtp, resend, webhook'
      );
      return null;
    }
    if (!p.isConfigured()) {
      logger.error('EMAIL_PROVIDER="' + explicit + '" is selected but its credentials are missing.');
      return null;
    }
    return p;
  }

  for (const key of ['smtp', 'resend', 'webhook']) {
    if (providers[key].isConfigured()) return providers[key];
  }
  return null;
}

function isConfigured() {
  return activeProvider() !== null;
}

function providerName() {
  const p = activeProvider();
  if (!p) return null;
  const cfg = p.name === 'smtp' ? smtpConfig() : null;
  return cfg ? cfg.label : p.name;
}

function buildOtpEmail(code, ttlSeconds) {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  const brand = process.env.EMAIL_SENDER_NAME || process.env.SMS_SENDER_NAME || 'AquaFlow';

  const text =
    `${code} is your ${brand} verification code.\n\n` +
    `It expires in ${minutes} minutes. Do not share this code with anyone.\n\n` +
    `If you did not request this, you can ignore this email.`;

  // Inline styles only - email clients strip <style> blocks.
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#eef3f8;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f8;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 14px rgba(8,32,52,.09);">
        <tr><td style="background:linear-gradient(135deg,#0a1a29,#15566e);padding:24px 28px;">
          <div style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-.02em;">${brand}</div>
          <div style="color:rgba(255,255,255,.75);font-size:13px;margin-top:2px;">Clean water, delivered to your door</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 6px;color:#3b5266;font-size:15px;">Your verification code is</p>
          <div style="font-size:36px;font-weight:800;letter-spacing:.22em;color:#0d1e2d;padding:14px 0 6px;">${code}</div>
          <p style="margin:10px 0 0;color:#66809a;font-size:13px;">
            It expires in <strong style="color:#3b5266;">${minutes} minutes</strong>. Do not share this code with anyone &mdash;
            our team will never ask you for it.
          </p>
          <hr style="border:none;border-top:1px solid #e2eaf1;margin:22px 0 14px;">
          <p style="margin:0;color:#8ea3b8;font-size:12px;">
            If you did not try to sign in, you can safely ignore this email.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject: `${code} is your ${brand} login code`, text, html };
}

/** Never throws: a mail outage becomes `{ sent: false }`. */
async function sendOtp(email, code, ttlSeconds) {
  const provider = activeProvider();
  if (!provider) return { sent: false, error: 'No email provider configured' };

  const { subject, text, html } = buildOtpEmail(code, ttlSeconds);
  try {
    const result = await provider.send({ to: email, subject, text, html });
    if (result.sent) {
      logger.info(`OTP emailed via ${providerName()} to ${maskEmail(email)}`, { id: result.id });
    } else {
      logger.error(`OTP email failed via ${providerName()} to ${maskEmail(email)}: ${result.error}`);
    }
    return Object.assign({ provider: providerName() }, result);
  } catch (err) {
    const aborted = err.name === 'AbortError';
    logger.error(`OTP email threw via ${providerName()}: ${aborted ? 'timed out' : err.message}`);
    return {
      sent: false,
      provider: providerName(),
      error: aborted ? 'Mail server timed out' : err.message,
    };
  }
}

module.exports = {
  providers,
  sendOtp,
  isConfigured,
  providerName,
  activeProvider,
  buildOtpEmail,
  maskEmail,
  smtpConfig,
};
