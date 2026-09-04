'use strict';

/**
 * Order lifecycle.
 *
 *   PENDING -> CONFIRMED -> DRIVER_ASSIGNED -> DRIVER_ACCEPTED
 *           -> OUT_FOR_DELIVERY -> ARRIVING -> DELIVERED
 *
 * Terminal: DELIVERED, CANCELLED, FAILED.
 * PAYMENT_FAILED is a recoverable side state - the customer can retry payment.
 *
 * A transition is legal only if BOTH the edge exists here AND the acting role is
 * listed for that edge. This is the single authority: controllers and sockets
 * both call `assertTransition` and nothing bypasses it.
 */

const STATUS = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  DRIVER_ACCEPTED: 'DRIVER_ACCEPTED',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  ARRIVING: 'ARRIVING',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
};

const TERMINAL = new Set([STATUS.DELIVERED, STATUS.CANCELLED, STATUS.FAILED]);

// from -> { to: [roles allowed to make this transition] }
const TRANSITIONS = {
  [STATUS.PENDING]: {
    [STATUS.CONFIRMED]: ['ADMIN', 'SYSTEM'],
    [STATUS.PAYMENT_FAILED]: ['SYSTEM'],
    [STATUS.CANCELLED]: ['CUSTOMER', 'ADMIN'],
    [STATUS.FAILED]: ['ADMIN', 'SYSTEM'],
  },
  [STATUS.PAYMENT_FAILED]: {
    [STATUS.CONFIRMED]: ['SYSTEM', 'ADMIN'],
    [STATUS.PENDING]: ['SYSTEM'],
    [STATUS.CANCELLED]: ['CUSTOMER', 'ADMIN'],
  },
  [STATUS.CONFIRMED]: {
    [STATUS.DRIVER_ASSIGNED]: ['ADMIN'],
    [STATUS.CANCELLED]: ['CUSTOMER', 'ADMIN'],
    [STATUS.FAILED]: ['ADMIN'],
  },
  [STATUS.DRIVER_ASSIGNED]: {
    [STATUS.DRIVER_ACCEPTED]: ['DRIVER', 'ADMIN'],
    // Driver rejects -> back to the dispatch pool.
    [STATUS.CONFIRMED]: ['DRIVER', 'ADMIN'],
    [STATUS.CANCELLED]: ['CUSTOMER', 'ADMIN'],
    [STATUS.FAILED]: ['ADMIN'],
  },
  [STATUS.DRIVER_ACCEPTED]: {
    [STATUS.OUT_FOR_DELIVERY]: ['DRIVER', 'ADMIN'],
    [STATUS.CANCELLED]: ['ADMIN'],
    [STATUS.FAILED]: ['ADMIN'],
  },
  [STATUS.OUT_FOR_DELIVERY]: {
    [STATUS.ARRIVING]: ['DRIVER', 'ADMIN', 'SYSTEM'],
    [STATUS.DELIVERED]: ['DRIVER', 'ADMIN'],
    [STATUS.FAILED]: ['DRIVER', 'ADMIN'],
  },
  [STATUS.ARRIVING]: {
    [STATUS.DELIVERED]: ['DRIVER', 'ADMIN'],
    [STATUS.FAILED]: ['DRIVER', 'ADMIN'],
  },
  [STATUS.DELIVERED]: {},
  [STATUS.CANCELLED]: {},
  [STATUS.FAILED]: {},
};

/** Statuses a customer is still allowed to cancel from. */
const CUSTOMER_CANCELLABLE = new Set([
  STATUS.PENDING,
  STATUS.PAYMENT_FAILED,
  STATUS.CONFIRMED,
  STATUS.DRIVER_ASSIGNED,
]);

function isTerminal(status) {
  return TERMINAL.has(status);
}

function canTransition(from, to, role) {
  const allowedRoles = TRANSITIONS[from] && TRANSITIONS[from][to];
  if (!allowedRoles) return false;
  return allowedRoles.includes(role);
}

function nextStatuses(from, role) {
  const edges = TRANSITIONS[from] || {};
  return Object.keys(edges).filter((to) => edges[to].includes(role));
}

/**
 * Throws a descriptive Error when the transition is not permitted.
 * Callers convert it to an ApiError(409).
 */
function assertTransition(from, to, role) {
  if (!STATUS[to]) {
    throw new Error(`Unknown order status "${to}".`);
  }
  if (from === to) {
    throw new Error(`Order is already ${from}.`);
  }
  if (isTerminal(from)) {
    throw new Error(`Order is ${from} and can no longer change.`);
  }
  if (!TRANSITIONS[from] || !TRANSITIONS[from][to]) {
    throw new Error(`Cannot move an order from ${from} to ${to}.`);
  }
  if (!TRANSITIONS[from][to].includes(role)) {
    throw new Error(`Role ${role} is not allowed to move an order from ${from} to ${to}.`);
  }
  return true;
}

/** Timestamp columns that should be stamped when entering a status. */
function timestampFor(status) {
  switch (status) {
    case STATUS.CONFIRMED:
      return 'confirmedAt';
    case STATUS.DRIVER_ASSIGNED:
      return 'assignedAt';
    case STATUS.OUT_FOR_DELIVERY:
      return 'pickedUpAt';
    case STATUS.DELIVERED:
      return 'deliveredAt';
    case STATUS.CANCELLED:
      return 'cancelledAt';
    default:
      return null;
  }
}

const CUSTOMER_LABELS = {
  PENDING: 'Waiting for confirmation',
  CONFIRMED: 'Order confirmed',
  DRIVER_ASSIGNED: 'Tanker assigned',
  DRIVER_ACCEPTED: 'Driver accepted',
  OUT_FOR_DELIVERY: 'Tanker on the way',
  ARRIVING: 'Arriving now',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  FAILED: 'Delivery failed',
  PAYMENT_FAILED: 'Payment failed',
};

module.exports = {
  STATUS,
  TRANSITIONS,
  TERMINAL,
  CUSTOMER_CANCELLABLE,
  CUSTOMER_LABELS,
  isTerminal,
  canTransition,
  nextStatuses,
  assertTransition,
  timestampFor,
};
