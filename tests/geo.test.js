'use strict';

const test = require('node:test');
const assert = require('node:assert');
const geo = require('../server/utils/geo');

test('haversine matches a known city-pair distance', () => {
  // Bengaluru -> Mysuru is about 128 km great-circle.
  const d = geo.haversineKm(12.9716, 77.5946, 12.2958, 76.6394);
  assert.ok(d > 120 && d < 135, `expected ~128 km, got ${d}`);
});

test('distance to self is zero', () => {
  assert.strictEqual(Math.round(geo.haversineKm(12.9716, 77.5946, 12.9716, 77.5946)), 0);
});

test('ETA grows with distance and never reads as zero', () => {
  const near = geo.estimateEtaMinutes(0.05);
  const far = geo.estimateEtaMinutes(20);
  assert.ok(near >= 2, 'a very close driver still shows at least 2 minutes');
  assert.ok(far > near);
});

test('ETA rejects nonsense input', () => {
  assert.strictEqual(geo.estimateEtaMinutes(NaN), null);
  assert.strictEqual(geo.estimateEtaMinutes(-5), null);
});

test('coordinate validation rejects out-of-range and non-numeric values', () => {
  assert.strictEqual(geo.isValidLatLng(12.97, 77.59), true);
  assert.strictEqual(geo.isValidLatLng(91, 77), false);
  assert.strictEqual(geo.isValidLatLng(12, 181), false);
  assert.strictEqual(geo.isValidLatLng('12', '77'), false);
  assert.strictEqual(geo.isValidLatLng(undefined, undefined), false);
});
