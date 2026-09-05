'use strict';

/**
 * Water-station routing: every order is anchored to the nearest active filling
 * station, and that station is what the tracking map draws the route from.
 *
 * Requires a running server (npm run dev) with DEMO_MODE=true and seeded data.
 */

const test = require('node:test');
const assert = require('node:assert');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

async function call(method, path, { body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const randomPhone = () => '9' + String(Math.floor(100000000 + Math.random() * 899999999));

async function signUpCustomer(name = 'Station Tester') {
  const phone = randomPhone();
  const req = await call('POST', '/api/auth/otp/request', { body: { phone } });
  const verify = await call('POST', '/api/auth/otp/verify', {
    body: { phone, code: req.body.data.demoCode, name },
  });
  return verify.body.data;
}

/**
 * Signs in once per test file and caches the result.
 *
 * Admin login is deliberately rate limited (10 per 15 min), so logging in per
 * test would trip the limiter and skip the suite. Returns the reason on
 * failure rather than a bare null - a skip that says "set ADMIN_SEED_PASSWORD"
 * when the real cause was a 429 sends you looking in the wrong place.
 */
let adminAuth = null;
async function adminToken() {
  if (adminAuth) return adminAuth.token;
  if (!process.env.ADMIN_SEED_PASSWORD) {
    adminAuth = { token: null, reason: 'ADMIN_SEED_PASSWORD is not set' };
    return null;
  }
  const res = await call('POST', '/api/auth/admin/login', {
    body: { phone: process.env.ADMIN_SEED_PHONE || '9000000001', password: process.env.ADMIN_SEED_PASSWORD },
  });
  if (res.status === 200) {
    adminAuth = { token: res.body.data.token, reason: null };
    return adminAuth.token;
  }
  adminAuth = {
    token: null,
    reason: `admin login failed (${res.status} ${res.body.error && res.body.error.code})` +
      (res.status === 429 ? ' - wait for the 15 minute login window to reset' : ''),
  };
  return null;
}

const skipReason = () => (adminAuth && adminAuth.reason) || 'admin login unavailable';

/** Places an order at the given coordinates and returns the created order. */
async function orderAt(latitude, longitude) {
  const cust = await signUpCustomer();
  const address = (await call('POST', '/api/addresses', {
    token: cust.token,
    body: { label: 'Home', fullAddress: 'Test address', latitude, longitude },
  })).body.data;
  const product = (await call('GET', '/api/products')).body.data[0];
  const created = await call('POST', '/api/orders', {
    token: cust.token,
    body: { productId: product.id, addressId: address.id, quantity: 1, paymentMethod: 'CASH_ON_DELIVERY' },
  });
  return { cust, order: created.body.data, status: created.status };
}

test('an order is anchored to a water station with a route distance', async (t) => {
  const token = await adminToken();
  if (!token) { t.skip(skipReason()); return; }

  const stations = (await call('GET', '/api/admin/stations', { token })).body.data;
  if (!stations.length) { t.skip('Seed water stations first: npm run db:seed'); return; }

  const { order } = await orderAt(12.9716, 77.5946);
  assert.ok(order.station, 'order should carry a route origin station');
  assert.ok(order.station.name, 'station should have a name');
  assert.ok(typeof order.routeKm === 'number' && order.routeKm >= 0, 'route distance should be computed');
});

/** True when an order can actually be placed at these coordinates. */
async function isServiceable(latitude, longitude) {
  const res = await call('GET', `/api/serviceability?latitude=${latitude}&longitude=${longitude}`);
  return res.status === 200 && res.body.data.serviceable;
}

test('the nearest active station wins', async (t) => {
  const token = await adminToken();
  if (!token) { t.skip(skipReason()); return; }

  const all = (await call('GET', '/api/admin/stations', { token })).body.data.filter((s) => s.isActive);

  // Only stations inside a service area can receive an order at all.
  const stations = [];
  for (const s of all) {
    if (await isServiceable(s.latitude, s.longitude)) stations.push(s);
  }
  if (stations.length < 2) { t.skip('Needs two active stations inside the service area'); return; }

  // Order right on top of one station - that station must be chosen.
  const target = stations[0];
  const first = await orderAt(target.latitude, target.longitude);
  assert.strictEqual(first.status, 201, JSON.stringify(first.order));
  assert.strictEqual(first.order.station.id, target.id, 'the closest station should be selected');
  assert.ok(first.order.routeKm < 0.5, `route from the co-located station should be ~0 km, got ${first.order.routeKm}`);

  // And a different one wins from a different corner.
  const other = stations[1];
  const second = await orderAt(other.latitude, other.longitude);
  assert.strictEqual(second.status, 201, JSON.stringify(second.order));
  assert.strictEqual(second.order.station.id, other.id, 'a different location should pick a different station');
});

test('tracking reports progress along the station to customer leg', async (t) => {
  const token = await adminToken();
  if (!token) { t.skip(skipReason()); return; }
  if (!process.env.DRIVER_SEED_PHONE) { t.skip('DRIVER_SEED_PHONE is not set'); return; }

  const { cust, order } = await orderAt(12.9716, 77.5946);
  assert.ok(order.station, 'needs a station');

  const dphone = process.env.DRIVER_SEED_PHONE;
  const d0 = await call('POST', '/api/auth/otp/request', { body: { phone: dphone } });
  const driver = (await call('POST', '/api/auth/otp/verify', {
    body: { phone: dphone, code: d0.body.data.demoCode },
  })).body.data;
  const dp = (await call('GET', '/api/driver/me', { token: driver.token })).body.data;

  await call('POST', `/api/admin/orders/${order.id}/assign-driver`, { token, body: { driverId: dp.id } });
  await call('POST', `/api/driver/orders/${order.id}/status`, { token: driver.token, body: { status: 'DRIVER_ACCEPTED' } });
  await call('POST', `/api/driver/orders/${order.id}/status`, { token: driver.token, body: { status: 'OUT_FOR_DELIVERY' } });

  // Driver sitting at the station: progress should be ~0.
  await call('POST', '/api/driver/location', {
    token: driver.token,
    body: { latitude: order.station.latitude, longitude: order.station.longitude },
  });
  let view = (await call('GET', `/api/orders/${order.id}`, { token: cust.token })).body.data;
  assert.ok(view.routeProgress !== null, 'progress should be computed');
  assert.ok(view.routeProgress < 0.2, `at the station progress should be near 0, got ${view.routeProgress}`);

  // Driver at the customer: progress should be ~1.
  await new Promise((r) => setTimeout(r, 3300)); // clear the server GPS throttle
  await call('POST', '/api/driver/location', {
    token: driver.token,
    body: { latitude: order.latitude, longitude: order.longitude },
  });
  view = (await call('GET', `/api/orders/${order.id}`, { token: cust.token })).body.data;
  assert.ok(view.routeProgress > 0.9, `at the door progress should be near 1, got ${view.routeProgress}`);

  await call('POST', `/api/driver/orders/${order.id}/status`, { token: driver.token, body: { status: 'DELIVERED' } });
});

test('stations are admin-only', async () => {
  const anon = await call('GET', '/api/admin/stations');
  assert.strictEqual(anon.status, 401);

  const cust = await signUpCustomer();
  const asCustomer = await call('GET', '/api/admin/stations', { token: cust.token });
  assert.strictEqual(asCustomer.status, 403);

  const write = await call('POST', '/api/admin/stations', {
    token: cust.token,
    body: { name: 'Rogue station', latitude: 12.9, longitude: 77.5 },
  });
  assert.strictEqual(write.status, 403, 'a customer must not be able to create a station');
});

test('an inactive station is not selected for new orders', async (t) => {
  const token = await adminToken();
  if (!token) { t.skip(skipReason()); return; }

  // A temporary station inside the service area (so orders are accepted) but
  // away from the seeded ones, making it unambiguously the nearest.
  const LAT = 12.9400;
  const LNG = 77.6400;
  if (!(await isServiceable(LAT, LNG))) { t.skip('Test coordinates are outside the configured service area'); return; }

  const temp = (await call('POST', '/api/admin/stations', {
    token, body: { name: 'Temp Disabled Station', latitude: LAT, longitude: LNG },
  })).body.data;

  // Always remove it, even if an assertion below fails - a leftover station
  // would silently skew every later run.
  t.after(() => call('DELETE', `/api/admin/stations/${temp.id}`, { token }));

  const near = await orderAt(LAT + 0.0001, LNG + 0.0001);
  assert.strictEqual(near.status, 201, JSON.stringify(near.order));
  assert.strictEqual(near.order.station.id, temp.id, 'while active it should be the nearest');

  await call('PATCH', `/api/admin/stations/${temp.id}`, { token, body: { isActive: false } });

  const after = await orderAt(LAT + 0.0001, LNG + 0.0001);
  assert.strictEqual(after.status, 201, JSON.stringify(after.order));
  assert.notStrictEqual(after.order.station.id, temp.id, 'a disabled station must not be selected');
});
