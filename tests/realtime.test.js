'use strict';

/**
 * Socket.IO live-tracking tests.
 *
 * These assert the two things that matter most about the realtime layer:
 * it actually delivers updates, and it never delivers them to the wrong person.
 *
 * Requires a running server (npm run dev) with DEMO_MODE=true.
 */

const test = require('node:test');
const assert = require('node:assert');
const { io } = require('socket.io-client');

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

async function signUpCustomer(name) {
  const phone = randomPhone();
  const req = await call('POST', '/api/auth/otp/request', { body: { phone } });
  const verify = await call('POST', '/api/auth/otp/verify', {
    body: { phone, code: req.body.data.demoCode, name },
  });
  return verify.body.data;
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 8000);
  });
}

const waitFor = (socket, event, ms = 8000) =>
  Promise.race([
    new Promise((r) => socket.once(event, r)),
    new Promise((r) => setTimeout(() => r(null), ms)),
  ]);

const emitAck = (socket, event, payload) =>
  new Promise((r) => {
    socket.emit(event, payload, r);
    setTimeout(() => r({ ok: false, error: 'ack timeout' }), 5000);
  });

test('an unauthenticated socket is rejected at the handshake', async () => {
  const err = await new Promise((resolve) => {
    const s = io(BASE, { auth: {}, transports: ['websocket'], reconnection: false });
    s.on('connect', () => { s.close(); resolve(null); });
    s.on('connect_error', (e) => { s.close(); resolve(e); });
    setTimeout(() => { s.close(); resolve(new Error('timeout')); }, 6000);
  });
  assert.ok(err, 'an anonymous socket must not be able to connect');
  assert.strictEqual(err.message, 'UNAUTHORIZED');
});

test('order rooms are private and live updates reach only the right people', async (t) => {
  if (!process.env.ADMIN_SEED_PASSWORD) {
    t.skip('Set ADMIN_SEED_PASSWORD and DRIVER_SEED_PHONE to run realtime tests');
    return;
  }

  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));

  // Actors
  const customer = await signUpCustomer('Realtime Customer');
  const stranger = await signUpCustomer('Nosy Neighbour');

  const admin = (await call('POST', '/api/auth/admin/login', {
    body: { phone: process.env.ADMIN_SEED_PHONE || '9000000001', password: process.env.ADMIN_SEED_PASSWORD },
  })).body.data;

  const dphone = process.env.DRIVER_SEED_PHONE || '9000000002';
  const dreq = await call('POST', '/api/auth/otp/request', { body: { phone: dphone } });
  const driver = (await call('POST', '/api/auth/otp/verify', {
    body: { phone: dphone, code: dreq.body.data.demoCode },
  })).body.data;
  const driverProfile = (await call('GET', '/api/driver/me', { token: driver.token })).body.data;

  // An order belonging to `customer`
  const address = (await call('POST', '/api/addresses', {
    token: customer.token,
    body: { label: 'Home', fullAddress: '5 Realtime Lane, Bengaluru', latitude: 12.9716, longitude: 77.5946 },
  })).body.data;
  const product = (await call('GET', '/api/products')).body.data[0];
  const order = (await call('POST', '/api/orders', {
    token: customer.token,
    body: { productId: product.id, addressId: address.id, quantity: 1, paymentMethod: 'CASH_ON_DELIVERY' },
  })).body.data;

  const cs = await connect(customer.token);
  const os = await connect(stranger.token);
  sockets.push(cs, os);

  // Room subscription is authorized per order.
  const mine = await emitAck(cs, 'order:subscribe', { orderId: order.id });
  assert.strictEqual(mine.ok, true, 'the owner must be able to subscribe');

  const theirs = await emitAck(os, 'order:subscribe', { orderId: order.id });
  assert.strictEqual(theirs.ok, false, 'a stranger must be refused the order room');

  // A status change is pushed live to the owner.
  const updatePromise = waitFor(cs, 'order:update');
  await call('POST', `/api/admin/orders/${order.id}/assign-driver`, {
    token: admin.token, body: { driverId: driverProfile.id },
  });
  const update = await updatePromise;
  assert.ok(update, 'customer should receive order:update over the socket');
  assert.strictEqual(update.status, 'DRIVER_ASSIGNED');

  // Driver GPS reaches the customer with distance + ETA.
  await call('POST', `/api/driver/orders/${order.id}/status`, { token: driver.token, body: { status: 'DRIVER_ACCEPTED' } });
  await call('POST', `/api/driver/orders/${order.id}/status`, { token: driver.token, body: { status: 'OUT_FOR_DELIVERY' } });

  const ds = await connect(driver.token);
  sockets.push(ds);

  let leakedToStranger = false;
  os.on('driver:location', () => { leakedToStranger = true; });

  const locPromise = waitFor(cs, 'driver:location');
  // Clear the server-side throttle window before pinging.
  await new Promise((r) => setTimeout(r, 3200));
  ds.emit('driver:location', { latitude: 12.99, longitude: 77.61 }, () => {});

  const loc = await locPromise;
  assert.ok(loc, 'customer should receive the driver position');
  assert.strictEqual(loc.orderId, order.id);
  assert.ok(loc.distanceKm > 0, 'distance should be computed server-side');
  assert.ok(loc.etaMinutes >= 2, 'ETA should be computed server-side');

  await new Promise((r) => setTimeout(r, 1000));
  assert.strictEqual(leakedToStranger, false, 'driver position must not leak to an unrelated customer');

  // A customer cannot publish a driver position.
  const spoof = await emitAck(cs, 'driver:location', { latitude: 1, longitude: 1 });
  assert.strictEqual(spoof.ok, false, 'only drivers may publish GPS');
});
