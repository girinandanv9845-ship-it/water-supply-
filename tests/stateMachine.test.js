'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fsm = require('../server/utils/orderStateMachine');

test('customer cannot skip the pipeline from PENDING to DELIVERED', () => {
  assert.strictEqual(fsm.canTransition('PENDING', 'DELIVERED', 'CUSTOMER'), false);
  assert.throws(() => fsm.assertTransition('PENDING', 'DELIVERED', 'CUSTOMER'), /Cannot move an order/);
});

test('customer cannot confirm their own order (payment/admin does)', () => {
  assert.strictEqual(fsm.canTransition('PENDING', 'CONFIRMED', 'CUSTOMER'), false);
  assert.strictEqual(fsm.canTransition('PENDING', 'CONFIRMED', 'SYSTEM'), true);
  assert.strictEqual(fsm.canTransition('PENDING', 'CONFIRMED', 'ADMIN'), true);
});

test('customer may cancel early but not once the tanker is rolling', () => {
  assert.strictEqual(fsm.canTransition('PENDING', 'CANCELLED', 'CUSTOMER'), true);
  assert.strictEqual(fsm.canTransition('CONFIRMED', 'CANCELLED', 'CUSTOMER'), true);
  assert.strictEqual(fsm.canTransition('DRIVER_ASSIGNED', 'CANCELLED', 'CUSTOMER'), true);
  assert.strictEqual(fsm.canTransition('OUT_FOR_DELIVERY', 'CANCELLED', 'CUSTOMER'), false);
  assert.strictEqual(fsm.canTransition('ARRIVING', 'CANCELLED', 'CUSTOMER'), false);
});

test('driver drives the delivery leg only', () => {
  assert.strictEqual(fsm.canTransition('DRIVER_ASSIGNED', 'DRIVER_ACCEPTED', 'DRIVER'), true);
  assert.strictEqual(fsm.canTransition('DRIVER_ACCEPTED', 'OUT_FOR_DELIVERY', 'DRIVER'), true);
  assert.strictEqual(fsm.canTransition('OUT_FOR_DELIVERY', 'DELIVERED', 'DRIVER'), true);
  // A driver must not assign themselves work or confirm a fresh order.
  assert.strictEqual(fsm.canTransition('CONFIRMED', 'DRIVER_ASSIGNED', 'DRIVER'), false);
  assert.strictEqual(fsm.canTransition('PENDING', 'CONFIRMED', 'DRIVER'), false);
});

test('terminal states are final for everyone, including admin', () => {
  ['DELIVERED', 'CANCELLED', 'FAILED'].forEach((terminal) => {
    assert.strictEqual(fsm.isTerminal(terminal), true);
    assert.throws(() => fsm.assertTransition(terminal, 'CONFIRMED', 'ADMIN'), /can no longer change/);
  });
});

test('a failed payment can be retried back into CONFIRMED', () => {
  assert.strictEqual(fsm.canTransition('PENDING', 'PAYMENT_FAILED', 'SYSTEM'), true);
  assert.strictEqual(fsm.canTransition('PAYMENT_FAILED', 'CONFIRMED', 'SYSTEM'), true);
});

test('driver rejection returns the order to the dispatch pool', () => {
  assert.strictEqual(fsm.canTransition('DRIVER_ASSIGNED', 'CONFIRMED', 'DRIVER'), true);
});

test('nextStatuses only offers role-legal moves', () => {
  const driverNext = fsm.nextStatuses('OUT_FOR_DELIVERY', 'DRIVER');
  assert.ok(driverNext.includes('DELIVERED'));
  assert.ok(driverNext.includes('ARRIVING'));
  assert.ok(!driverNext.includes('CANCELLED'));
});

test('same-status and unknown-status transitions are rejected', () => {
  assert.throws(() => fsm.assertTransition('CONFIRMED', 'CONFIRMED', 'ADMIN'), /already CONFIRMED/);
  assert.throws(() => fsm.assertTransition('CONFIRMED', 'NOT_A_STATUS', 'ADMIN'), /Unknown order status/);
});
