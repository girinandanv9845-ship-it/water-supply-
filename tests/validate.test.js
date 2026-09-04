'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { fields } = require('../server/middleware/validate');

const parse = (v) => fields.phone.parse(v);

test('accepts a plain 10-digit mobile number', () => {
  assert.strictEqual(parse('9876543210'), '9876543210');
  assert.strictEqual(parse('6123456789'), '6123456789');
});

test('strips a country or trunk prefix only when 10 digits remain', () => {
  assert.strictEqual(parse('+919876543210'), '9876543210');
  assert.strictEqual(parse('919876543210'), '9876543210');
  assert.strictEqual(parse('09876543210'), '9876543210');
});

test('regression: a subscriber number starting with 91 is not mangled', () => {
  // A blind /^91/ strip turned this into "23456789" and rejected a real user.
  assert.strictEqual(parse('9123456789'), '9123456789');
  assert.strictEqual(parse('9100000009'), '9100000009');
  assert.strictEqual(parse('+919123456789'), '9123456789');
});

test('tolerates spaces, dashes and brackets', () => {
  assert.strictEqual(parse('98765 43210'), '9876543210');
  assert.strictEqual(parse('(987) 654-3210'), '9876543210');
});

test('rejects numbers that are not valid Indian mobiles', () => {
  ['12345', '1234567890', '5876543210', '98765432101', 'abcdefghij', ''].forEach((bad) => {
    assert.throws(() => parse(bad), `expected "${bad}" to be rejected`);
  });
});
