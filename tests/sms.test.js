'use strict';

/**
 * SMS gateway selection and the rule that matters most:
 * a configured gateway must never hand the OTP back to the caller.
 */

const test = require('node:test');
const assert = require('node:assert');

// Each test controls its own env, so load the module fresh every time.
function loadSms(env) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('sms.service')) delete require.cache[k];
  }
  const saved = {};
  const keys = [
    'SMS_PROVIDER', 'SMS_SENDER_NAME', 'SMS_OTP_TEMPLATE', 'SMS_COUNTRY_CODE',
    'MSG91_AUTH_KEY', 'MSG91_TEMPLATE_ID', 'MSG91_SENDER_ID',
    'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM',
    'FAST2SMS_API_KEY', 'SMS_WEBHOOK_URL',
  ];
  keys.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.keys(env || {}).forEach((k) => { process.env[k] = env[k]; });

  const mod = require('../server/services/sms.service');
  return {
    sms: mod,
    restore: function () {
      keys.forEach((k) => {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      });
    },
  };
}

test('no credentials means no gateway', (t) => {
  const { sms, restore } = loadSms({});
  t.after(restore);
  assert.strictEqual(sms.isConfigured(), false);
  assert.strictEqual(sms.providerName(), null);
});

test('credentials alone activate a provider - no SMS_PROVIDER needed', (t) => {
  const { sms, restore } = loadSms({ MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 't' });
  t.after(restore);
  assert.strictEqual(sms.isConfigured(), true);
  assert.strictEqual(sms.providerName(), 'msg91');
});

test('partial credentials do not activate a provider', (t) => {
  // Auth key without a template id would fail at the gateway, so it must not
  // count as configured - otherwise production would boot and then reject
  // every login.
  const { sms, restore } = loadSms({ MSG91_AUTH_KEY: 'k' });
  t.after(restore);
  assert.strictEqual(sms.isConfigured(), false);
});

test('SMS_PROVIDER picks a specific gateway when several are configured', (t) => {
  const { sms, restore } = loadSms({
    SMS_PROVIDER: 'twilio',
    MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 't',
    TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15550000000',
  });
  t.after(restore);
  assert.strictEqual(sms.providerName(), 'twilio');
});

test('an unknown or uncredentialed SMS_PROVIDER is treated as unconfigured', (t) => {
  const a = loadSms({ SMS_PROVIDER: 'pigeon-post' });
  assert.strictEqual(a.sms.isConfigured(), false);
  a.restore();

  const b = loadSms({ SMS_PROVIDER: 'twilio' }); // named but no credentials
  assert.strictEqual(b.sms.isConfigured(), false);
  b.restore();
});

test('the OTP message carries the code, the brand and an expiry', (t) => {
  const { sms, restore } = loadSms({ SMS_SENDER_NAME: 'AquaFlow' });
  t.after(restore);
  const msg = sms.buildOtpMessage('483920', 300);
  assert.match(msg, /483920/);
  assert.match(msg, /AquaFlow/);
  assert.match(msg, /5 minutes/);
  assert.match(msg, /not share/i);
});

test('a custom template is honoured for DLT compliance', (t) => {
  const { sms, restore } = loadSms({ SMS_OTP_TEMPLATE: 'Your code is {code}. Valid {minutes} min.' });
  t.after(restore);
  assert.strictEqual(sms.buildOtpMessage('112233', 600), 'Your code is 112233. Valid 10 min.');
});

test('phone numbers are masked for logs and E.164-formatted for gateways', (t) => {
  const { sms, restore } = loadSms({});
  t.after(restore);
  assert.strictEqual(sms.maskPhone('9876543210'), '987*****10');
  assert.strictEqual(sms.e164('9876543210'), '+919876543210');
});

test('a gateway failure reports sent:false rather than throwing', async (t) => {
  const { sms, restore } = loadSms({
    SMS_PROVIDER: 'webhook',
    SMS_WEBHOOK_URL: 'http://127.0.0.1:1/definitely-not-listening',
  });
  t.after(restore);

  const result = await sms.sendOtp('9876543210', '123456', 300);
  assert.strictEqual(result.sent, false, 'must not throw - the caller returns a clean 503');
  assert.ok(result.error, 'the reason is captured for the server log');
});

test('SECURITY: a working gateway never returns the code to the caller', async (t) => {
  // Stand up a fake gateway that accepts everything.
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
  const port = server.address().port;
  t.after(() => server.close());

  const { sms, restore } = loadSms({
    SMS_PROVIDER: 'webhook',
    SMS_WEBHOOK_URL: 'http://127.0.0.1:' + port + '/send',
  });
  t.after(restore);

  const result = await sms.sendOtp('9876543210', '654321', 300);

  assert.strictEqual(result.sent, true, 'the send should succeed');
  // The gateway receives the code - that is the whole point.
  assert.strictEqual(received.length, 1);
  assert.match(received[0].message, /654321/);
  assert.strictEqual(received[0].to, '+919876543210');
  // But the result handed back to the app must not carry it.
  assert.strictEqual(
    JSON.stringify(result).includes('654321'),
    false,
    'the send result must not contain the OTP - it would reach the browser'
  );
});
