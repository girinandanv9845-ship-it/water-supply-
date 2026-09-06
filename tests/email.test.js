'use strict';

/** Email provider selection, message content, and the no-leak rule. */

const test = require('node:test');
const assert = require('node:assert');

function loadEmail(env) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('email.service')) delete require.cache[k];
  }
  const keys = [
    'EMAIL_PROVIDER', 'EMAIL_FROM', 'EMAIL_SENDER_NAME', 'SMS_SENDER_NAME',
    'GMAIL_USER', 'GMAIL_APP_PASSWORD',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS',
    'RESEND_API_KEY', 'EMAIL_WEBHOOK_URL',
  ];
  const saved = {};
  keys.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.keys(env || {}).forEach((k) => { process.env[k] = env[k]; });

  return {
    email: require('../server/services/email.service'),
    restore() {
      keys.forEach((k) => {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      });
    },
  };
}

test('no credentials means no email provider', (t) => {
  const { email, restore } = loadEmail({});
  t.after(restore);
  assert.strictEqual(email.isConfigured(), false);
  assert.strictEqual(email.providerName(), null);
});

test('Gmail credentials configure SMTP with the right host and implicit TLS', (t) => {
  const { email, restore } = loadEmail({
    EMAIL_PROVIDER: 'gmail',
    GMAIL_USER: 'shop@gmail.com',
    GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop',
  });
  t.after(restore);

  assert.strictEqual(email.isConfigured(), true);
  assert.strictEqual(email.providerName(), 'gmail');

  const cfg = email.smtpConfig();
  assert.strictEqual(cfg.host, 'smtp.gmail.com');
  assert.strictEqual(cfg.port, 465);
  assert.strictEqual(cfg.secure, true, 'port 465 must use implicit TLS');
  assert.match(cfg.from, /shop@gmail\.com/);
});

test('a Gmail user without an app password is not configured', (t) => {
  const { email, restore } = loadEmail({ EMAIL_PROVIDER: 'gmail', GMAIL_USER: 'shop@gmail.com' });
  t.after(restore);
  assert.strictEqual(email.isConfigured(), false);
});

test('a generic SMTP server uses STARTTLS on 587 and implicit TLS on 465', (t) => {
  const a = loadEmail({ SMTP_HOST: 'smtp.zoho.com', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p' });
  assert.strictEqual(a.email.smtpConfig().secure, false, '587 upgrades via STARTTLS');
  a.restore();

  const b = loadEmail({ SMTP_HOST: 'smtp.zoho.com', SMTP_PORT: '465', SMTP_USER: 'u', SMTP_PASS: 'p' });
  assert.strictEqual(b.email.smtpConfig().secure, true);
  b.restore();
});

test('an unknown EMAIL_PROVIDER is treated as unconfigured', (t) => {
  const { email, restore } = loadEmail({ EMAIL_PROVIDER: 'carrier-pigeon' });
  t.after(restore);
  assert.strictEqual(email.isConfigured(), false);
});

test('the OTP email carries the code, expiry and a do-not-share warning', (t) => {
  const { email, restore } = loadEmail({ EMAIL_SENDER_NAME: 'AquaFlow' });
  t.after(restore);

  const { subject, text, html } = email.buildOtpEmail('483920', 300);
  assert.match(subject, /483920/);
  assert.match(text, /483920/);
  assert.match(text, /5 minutes/);
  assert.match(text, /not share/i);
  assert.match(html, /483920/);
  // Email clients strip <style> blocks, so styling has to be inline.
  assert.ok(!/<style/i.test(html), 'no <style> block - clients strip it');
  assert.match(html, /style="/, 'styling is inline');
});

test('addresses are masked for logs', (t) => {
  const { email, restore } = loadEmail({});
  t.after(restore);
  assert.strictEqual(email.maskEmail('customer@gmail.com'), 'cu******@gmail.com');
  assert.strictEqual(email.maskEmail('ab@x.com'), 'ab*@x.com');
  assert.strictEqual(email.maskEmail('not-an-email'), '***');
});

test('a provider failure reports sent:false rather than throwing', async (t) => {
  const { email, restore } = loadEmail({
    EMAIL_PROVIDER: 'webhook',
    EMAIL_WEBHOOK_URL: 'http://127.0.0.1:1/nothing-here',
  });
  t.after(restore);

  const result = await email.sendOtp('a@b.com', '123456', 300);
  assert.strictEqual(result.sent, false);
  assert.ok(result.error);
});

test('SECURITY: a working provider never returns the code to the caller', async (t) => {
  const http = require('node:http');
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());

  const { email, restore } = loadEmail({
    EMAIL_PROVIDER: 'webhook',
    EMAIL_WEBHOOK_URL: 'http://127.0.0.1:' + server.address().port + '/send',
  });
  t.after(restore);

  const result = await email.sendOtp('customer@gmail.com', '654321', 300);

  assert.strictEqual(result.sent, true);
  assert.strictEqual(received.length, 1);
  assert.match(received[0].message, /654321/, 'the inbox gets the code');
  assert.strictEqual(
    JSON.stringify(result).includes('654321'),
    false,
    'the send result must not carry the OTP - it would reach the browser'
  );
});
