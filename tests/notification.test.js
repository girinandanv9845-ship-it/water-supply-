'use strict';

/**
 * Notification channel selection.
 *
 * The regression guarded here: the SMS and EMAIL providers used to check
 * `SMS_PROVIDER_KEY` / `SMTP_URL`, env vars that no longer exist, and always
 * returned `delivered: false`. Configuring Gmail therefore delivered login
 * codes but silently never delivered order updates.
 */

const test = require('node:test');
const assert = require('node:assert');

function load(env) {
  for (const k of Object.keys(require.cache)) {
    if (/notification\.service|sms\.service|email\.service/.test(k)) delete require.cache[k];
  }
  const keys = [
    'NOTIFY_CHANNELS', 'SMS_PROVIDER', 'SMS_WEBHOOK_URL',
    'EMAIL_PROVIDER', 'EMAIL_WEBHOOK_URL', 'GMAIL_USER', 'GMAIL_APP_PASSWORD',
  ];
  const saved = {};
  keys.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.keys(env || {}).forEach((k) => { process.env[k] = env[k]; });

  return {
    notif: require('../server/services/notification.service'),
    restore() {
      keys.forEach((k) => {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      });
    },
  };
}

test('IN_APP only by default - external channels are opt-in', (t) => {
  const { notif, restore } = load({});
  t.after(restore);
  assert.deepStrictEqual(notif.defaultChannels(), ['IN_APP']);
});

test('NOTIFY_CHANNELS adds channels, and IN_APP is always kept', (t) => {
  const a = load({ NOTIFY_CHANNELS: 'IN_APP,EMAIL' });
  assert.deepStrictEqual(a.notif.defaultChannels(), ['IN_APP', 'EMAIL']);
  a.restore();

  // Even if the operator omits it, the bell icon must keep working.
  const b = load({ NOTIFY_CHANNELS: 'EMAIL' });
  assert.deepStrictEqual(b.notif.defaultChannels(), ['IN_APP', 'EMAIL']);
  b.restore();
});

test('unknown channel names are ignored rather than crashing dispatch', (t) => {
  const { notif, restore } = load({ NOTIFY_CHANNELS: 'IN_APP,CARRIER_PIGEON,EMAIL' });
  t.after(restore);
  assert.deepStrictEqual(notif.defaultChannels(), ['IN_APP', 'EMAIL']);
});

test('channel names are case and whitespace tolerant', (t) => {
  const { notif, restore } = load({ NOTIFY_CHANNELS: ' in_app , email ' });
  t.after(restore);
  assert.deepStrictEqual(notif.defaultChannels(), ['IN_APP', 'EMAIL']);
});

test('REGRESSION: EMAIL reports configured once a mail provider exists', (t) => {
  const off = load({});
  assert.strictEqual(off.notif.providers.EMAIL.isConfigured(), false, 'no provider -> off');
  off.restore();

  const on = load({ EMAIL_PROVIDER: 'gmail', GMAIL_USER: 'a@gmail.com', GMAIL_APP_PASSWORD: 'x y z' });
  assert.strictEqual(
    on.notif.providers.EMAIL.isConfigured(),
    true,
    'configuring Gmail must enable order-update emails, not just OTPs'
  );
  on.restore();
});

test('REGRESSION: SMS reports configured once a gateway exists', (t) => {
  const off = load({});
  assert.strictEqual(off.notif.providers.SMS.isConfigured(), false);
  off.restore();

  const on = load({ SMS_PROVIDER: 'webhook', SMS_WEBHOOK_URL: 'https://example.test/sms' });
  assert.strictEqual(on.notif.providers.SMS.isConfigured(), true);
  on.restore();
});

test('a channel with no contact detail on file is skipped, not attempted', async (t) => {
  const { notif, restore } = load({
    EMAIL_PROVIDER: 'webhook',
    EMAIL_WEBHOOK_URL: 'http://127.0.0.1:1/never-called',
  });
  t.after(restore);

  // An email-only customer has no phone; the SMS channel must bail cleanly
  // rather than calling the gateway with `undefined`.
  const smsResult = await notif.providers.SMS.send(
    { title: 'Delivered', body: 'Order AQ-1 delivered' },
    { phone: null, email: 'a@b.com' }
  );
  assert.strictEqual(smsResult.delivered, false);
  assert.match(smsResult.reason, /No phone/i);

  const emailResult = await notif.providers.EMAIL.send(
    { title: 'Delivered', body: 'Order AQ-1 delivered' },
    { phone: '9876543210', email: null }
  );
  assert.strictEqual(emailResult.delivered, false);
  assert.match(emailResult.reason, /No email/i);
});
