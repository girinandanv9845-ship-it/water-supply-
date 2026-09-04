'use strict';

/**
 * End-to-end API tests against a running server.
 *
 *   Terminal 1:  npm run dev
 *   Terminal 2:  npm test
 *
 * Requires DEMO_MODE=true so OTP codes are returned by the API.
 * Every run creates fresh customers with random phone numbers, so it is safe to
 * run repeatedly against a development database.
 */

const test = require('node:test');
const assert = require('node:assert');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

/* ---------------- helpers ---------------- */

async function call(method, path, { body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

/** A random unused Indian mobile number for each test run. */
function randomPhone() {
  return '9' + String(Math.floor(100000000 + Math.random() * 899999999));
}

async function signUpCustomer(name = 'Test Customer') {
  const phone = randomPhone();
  const req = await call('POST', '/api/auth/otp/request', { body: { phone } });
  assert.strictEqual(req.status, 200, 'OTP request should succeed');
  assert.ok(req.body.data.demoCode, 'demo mode must return the code (set DEMO_MODE=true)');

  const verify = await call('POST', '/api/auth/otp/verify', {
    body: { phone, code: req.body.data.demoCode, name },
  });
  assert.strictEqual(verify.status, 200, 'OTP verify should succeed');
  return { phone, token: verify.body.data.token, user: verify.body.data.user };
}

async function adminToken() {
  const phone = process.env.ADMIN_SEED_PHONE || '9000000001';
  const password = process.env.ADMIN_SEED_PASSWORD;
  if (!password) return null;
  const res = await call('POST', '/api/auth/admin/login', { body: { phone, password } });
  return res.status === 200 ? res.body.data.token : null;
}

async function makeAddress(token) {
  const res = await call('POST', '/api/addresses', {
    token,
    body: {
      label: 'Home',
      fullAddress: '12 Test Street, Test Layout, Bengaluru',
      latitude: 12.9716,
      longitude: 77.5946,
    },
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

async function firstProduct() {
  const res = await call('GET', '/api/products');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.data.length > 0, 'seed the database first: npm run db:seed');
  return res.body.data[0];
}

/* ================= health & config ================= */

test('health endpoint reports a connected database', async () => {
  const res = await call('GET', '/api/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.database, 'connected');
});

test('public config never exposes server-side secrets', async () => {
  const res = await call('GET', '/api/config');
  assert.strictEqual(res.status, 200);
  const keys = Object.keys(res.body.data);
  assert.ok(!keys.some((k) => /secret/i.test(k)), 'config must not contain any *secret* key');
  assert.strictEqual(res.body.data.razorpayKeySecret, undefined);
  assert.strictEqual(res.body.data.jwtSecret, undefined);
});

/* ================= auth ================= */

test('OTP login creates a customer and returns a usable token', async () => {
  const { token, user } = await signUpCustomer('Asha Rao');
  assert.strictEqual(user.role, 'CUSTOMER');

  const me = await call('GET', '/api/auth/me', { token });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.data.user.name, 'Asha Rao');
});

test('a wrong OTP is rejected', async () => {
  const phone = randomPhone();
  await call('POST', '/api/auth/otp/request', { body: { phone } });
  const res = await call('POST', '/api/auth/otp/verify', {
    body: { phone, code: '000000', name: 'Nobody' },
  });
  assert.strictEqual(res.status, 400);
});

test('a client cannot self-assign the ADMIN or DRIVER role at signup', async () => {
  const phone = randomPhone();
  const req = await call('POST', '/api/auth/otp/request', { body: { phone } });
  const verify = await call('POST', '/api/auth/otp/verify', {
    body: { phone, code: req.body.data.demoCode, name: 'Sneaky', role: 'ADMIN' },
  });
  assert.strictEqual(verify.status, 200);
  assert.strictEqual(verify.body.data.user.role, 'CUSTOMER', 'role must be server-assigned');
});

test('malformed phone numbers are rejected by validation', async () => {
  const res = await call('POST', '/api/auth/otp/request', { body: { phone: '12345' } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error.code, 'BAD_REQUEST');
});

/* ================= authorization ================= */

test('protected routes reject anonymous callers', async () => {
  for (const path of ['/api/addresses', '/api/orders', '/api/notifications', '/api/driver/orders', '/api/admin/stats']) {
    const res = await call('GET', path);
    assert.strictEqual(res.status, 401, `${path} should require auth, got ${res.status}`);
  }
});

test('a customer token cannot reach admin or driver endpoints', async () => {
  const { token } = await signUpCustomer();
  const admin = await call('GET', '/api/admin/stats', { token });
  assert.strictEqual(admin.status, 403);
  const driver = await call('GET', '/api/driver/orders', { token });
  assert.strictEqual(driver.status, 403);
});

test('a forged token is rejected', async () => {
  const res = await call('GET', '/api/auth/me', { token: 'not.a.real.token' });
  assert.strictEqual(res.status, 401);
});

/* ================= addresses ================= */

test('addresses are private to their owner', async () => {
  const alice = await signUpCustomer('Alice');
  const bob = await signUpCustomer('Bob');

  const addr = await makeAddress(alice.token);

  const bobList = await call('GET', '/api/addresses', { token: bob.token });
  assert.strictEqual(bobList.status, 200);
  assert.ok(!bobList.body.data.some((a) => a.id === addr.id), "Bob must not see Alice's address");

  const bobDelete = await call('DELETE', `/api/addresses/${addr.id}`, { token: bob.token });
  assert.strictEqual(bobDelete.status, 404, "Bob must not be able to delete Alice's address");
});

/* ================= orders & pricing ================= */

test('order total is computed server-side and ignores a client-supplied price', async () => {
  const { token } = await signUpCustomer();
  const address = await makeAddress(token);
  const product = await firstProduct();

  const res = await call('POST', '/api/orders', {
    token,
    body: {
      productId: product.id,
      addressId: address.id,
      quantity: 2,
      // Hostile client fields - all must be ignored.
      price: 1,
      totalInPaise: 1,
      status: 'DELIVERED',
      paymentMethod: 'ONLINE',
    },
  });

  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const order = res.body.data;
  assert.strictEqual(order.totalInPaise, product.priceInPaise * 2, 'price must come from the catalog');
  assert.strictEqual(order.status, 'PENDING', 'client cannot set the initial status');
});

test('a customer cannot order using another customer address', async () => {
  const alice = await signUpCustomer('Alice2');
  const bob = await signUpCustomer('Bob2');
  const aliceAddr = await makeAddress(alice.token);
  const product = await firstProduct();

  const res = await call('POST', '/api/orders', {
    token: bob.token,
    body: { productId: product.id, addressId: aliceAddr.id, quantity: 1 },
  });
  assert.strictEqual(res.status, 400);
});

test('a customer cannot read another customer order', async () => {
  const alice = await signUpCustomer('Alice3');
  const bob = await signUpCustomer('Bob3');
  const addr = await makeAddress(alice.token);
  const product = await firstProduct();

  const created = await call('POST', '/api/orders', {
    token: alice.token,
    body: { productId: product.id, addressId: addr.id, quantity: 1 },
  });
  const orderId = created.body.data.id;

  const peek = await call('GET', `/api/orders/${orderId}`, { token: bob.token });
  assert.strictEqual(peek.status, 404, 'cross-customer reads must look like "not found"');

  const track = await call('GET', `/api/orders/${orderId}/track`, { token: bob.token });
  assert.strictEqual(track.status, 404);

  const cancel = await call('POST', `/api/orders/${orderId}/cancel`, { token: bob.token, body: {} });
  assert.strictEqual(cancel.status, 404);
});

test('cash-on-delivery orders are confirmed immediately', async () => {
  const { token } = await signUpCustomer();
  const address = await makeAddress(token);
  const product = await firstProduct();

  const res = await call('POST', '/api/orders', {
    token,
    body: { productId: product.id, addressId: address.id, quantity: 1, paymentMethod: 'CASH_ON_DELIVERY' },
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.data.status, 'CONFIRMED');
});

test('a customer can cancel a pending order and then no longer change it', async () => {
  const { token } = await signUpCustomer();
  const address = await makeAddress(token);
  const product = await firstProduct();

  const created = await call('POST', '/api/orders', {
    token, body: { productId: product.id, addressId: address.id, quantity: 1 },
  });
  const id = created.body.data.id;

  const cancelled = await call('POST', `/api/orders/${id}/cancel`, { token, body: { reason: 'Changed my mind' } });
  assert.strictEqual(cancelled.status, 200);
  assert.strictEqual(cancelled.body.data.status, 'CANCELLED');

  const again = await call('POST', `/api/orders/${id}/cancel`, { token, body: {} });
  assert.strictEqual(again.status, 409, 'a cancelled order is terminal');
});

/* ================= payments ================= */

test('demo payment confirms the order and is idempotent', async () => {
  const { token } = await signUpCustomer();
  const address = await makeAddress(token);
  const product = await firstProduct();

  const created = await call('POST', '/api/orders', {
    token, body: { productId: product.id, addressId: address.id, quantity: 1 },
  });
  const order = created.body.data;

  const intent = await call('POST', '/api/payments/create', { token, body: { orderId: order.id } });
  assert.strictEqual(intent.status, 200, JSON.stringify(intent.body));
  assert.strictEqual(intent.body.data.amountInPaise, order.totalInPaise, 'gateway amount must match the order');
  assert.strictEqual(intent.body.data.keyId, null, 'no live key is issued in demo mode');

  const verify = await call('POST', '/api/payments/verify', {
    token, body: { providerOrderId: intent.body.data.providerOrderId },
  });
  assert.strictEqual(verify.status, 200);
  assert.strictEqual(verify.body.data.status, 'PAID');
  assert.strictEqual(verify.body.data.alreadyProcessed, false);

  // Replaying the same verification must not double-process.
  const replay = await call('POST', '/api/payments/verify', {
    token, body: { providerOrderId: intent.body.data.providerOrderId },
  });
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.body.data.alreadyProcessed, true, 'duplicate verification must be idempotent');

  const after = await call('GET', `/api/orders/${order.id}`, { token });
  assert.strictEqual(after.body.data.status, 'CONFIRMED', 'payment confirms the order');
  assert.strictEqual(after.body.data.paymentStatus, 'PAID');
});

test('a customer cannot settle another customer payment', async () => {
  const alice = await signUpCustomer('Alice4');
  const bob = await signUpCustomer('Bob4');
  const addr = await makeAddress(alice.token);
  const product = await firstProduct();

  const order = (await call('POST', '/api/orders', {
    token: alice.token, body: { productId: product.id, addressId: addr.id, quantity: 1 },
  })).body.data;

  const intent = await call('POST', '/api/payments/create', { token: alice.token, body: { orderId: order.id } });

  const stolen = await call('POST', '/api/payments/verify', {
    token: bob.token, body: { providerOrderId: intent.body.data.providerOrderId },
  });
  assert.strictEqual(stolen.status, 403);
});

test('paying twice for one order is refused', async () => {
  const { token } = await signUpCustomer();
  const address = await makeAddress(token);
  const product = await firstProduct();

  const order = (await call('POST', '/api/orders', {
    token, body: { productId: product.id, addressId: address.id, quantity: 1 },
  })).body.data;

  const intent = await call('POST', '/api/payments/create', { token, body: { orderId: order.id } });
  await call('POST', '/api/payments/verify', { token, body: { providerOrderId: intent.body.data.providerOrderId } });

  const second = await call('POST', '/api/payments/create', { token, body: { orderId: order.id } });
  assert.strictEqual(second.status, 409);
});

/* ================= chatbot ================= */

test('chatbot answers pricing from the catalog, not from invention', async () => {
  const res = await call('POST', '/api/chat', { body: { message: 'What are your prices?' } });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.data.reply.length > 0);
  const product = await firstProduct();
  assert.ok(
    res.body.data.reply.includes(String(product.priceRupees)) || res.body.data.reply.includes(product.name),
    'the reply should quote real catalog data'
  );
});

test('chatbot refuses to invent unknown facts', async () => {
  const res = await call('POST', '/api/chat', {
    body: { message: 'Do you sell industrial diesel generators on credit?' },
  });
  assert.strictEqual(res.status, 200);
  assert.match(res.body.data.reply, /don't have that information|contact support/i);
});

test('chatbot gives no order context to an anonymous visitor', async () => {
  const res = await call('POST', '/api/chat', { body: { message: 'Where is my tanker?' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.hasOrderContext, false);
});

test('chatbot sees only the signed-in customer own order', async () => {
  const { token } = await signUpCustomer('Chat User');
  const address = await makeAddress(token);
  const product = await firstProduct();
  const order = (await call('POST', '/api/orders', {
    token, body: { productId: product.id, addressId: address.id, quantity: 1 },
  })).body.data;

  const res = await call('POST', '/api/chat', { token, body: { message: 'Where is my tanker?' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.hasOrderContext, true);
  assert.ok(res.body.data.reply.includes(order.orderNumber), 'should reference their own order number');
});

/* ================= admin flow (skipped without credentials) ================= */

test('admin dashboard and driver assignment', async (t) => {
  const token = await adminToken();
  if (!token) {
    t.skip('Set ADMIN_SEED_PASSWORD in the environment to run admin tests');
    return;
  }

  const stats = await call('GET', '/api/admin/stats', { token });
  assert.strictEqual(stats.status, 200);
  assert.ok(typeof stats.body.data.totalOrders === 'number');
  assert.ok(Array.isArray(stats.body.data.series));

  // Build a confirmed order to dispatch.
  const customer = await signUpCustomer('Dispatch Target');
  const address = await makeAddress(customer.token);
  const product = await firstProduct();
  const order = (await call('POST', '/api/orders', {
    token: customer.token,
    body: { productId: product.id, addressId: address.id, quantity: 1, paymentMethod: 'CASH_ON_DELIVERY' },
  })).body.data;
  assert.strictEqual(order.status, 'CONFIRMED');

  const drivers = await call('GET', '/api/admin/drivers', { token });
  assert.strictEqual(drivers.status, 200);
  const driver = drivers.body.data.find((d) => d.isVerified);
  assert.ok(driver, 'seed a verified driver first: npm run db:seed');

  const assigned = await call('POST', `/api/admin/orders/${order.id}/assign-driver`, {
    token, body: { driverId: driver.id },
  });
  assert.strictEqual(assigned.status, 200, JSON.stringify(assigned.body));
  assert.strictEqual(assigned.body.data.status, 'DRIVER_ASSIGNED');

  // An illegal jump must be refused even for an admin.
  const illegal = await call('POST', `/api/admin/orders/${order.id}/status`, {
    token, body: { status: 'PENDING' },
  });
  assert.strictEqual(illegal.status, 409, 'the state machine must reject a backwards jump');
});

test('admin can change pricing and it takes effect for new orders', async (t) => {
  const token = await adminToken();
  if (!token) { t.skip('Set ADMIN_SEED_PASSWORD to run admin tests'); return; }

  const products = await call('GET', '/api/admin/products', { token });
  const product = products.body.data[0];
  const originalRupees = product.priceRupees;
  const newRupees = originalRupees + 37;

  const updated = await call('PATCH', `/api/admin/products/${product.id}`, {
    token, body: { priceRupees: newRupees },
  });
  assert.strictEqual(updated.status, 200);

  const customer = await signUpCustomer('Price Check');
  const address = await makeAddress(customer.token);
  const order = (await call('POST', '/api/orders', {
    token: customer.token, body: { productId: product.id, addressId: address.id, quantity: 1 },
  })).body.data;
  assert.strictEqual(order.totalInPaise, Math.round(newRupees * 100));

  // Restore so repeated runs stay stable.
  await call('PATCH', `/api/admin/products/${product.id}`, { token, body: { priceRupees: originalRupees } });
});

/* ================= misc ================= */

test('unknown API routes return a structured 404', async () => {
  const res = await call('GET', '/api/does-not-exist');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(res.body.error.code, 'NOT_FOUND');
});

test('invalid JSON produces a clean 400, not a crash', async () => {
  const res = await fetch(BASE + '/api/auth/otp/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ this is not json',
  });
  assert.strictEqual(res.status, 400);
  const health = await call('GET', '/api/health');
  assert.strictEqual(health.status, 200, 'server must still be alive');
});

test('an invalid order id is handled gracefully', async () => {
  const { token } = await signUpCustomer();
  const res = await call('GET', '/api/orders/definitely-not-an-id', { token });
  assert.strictEqual(res.status, 404);
});
