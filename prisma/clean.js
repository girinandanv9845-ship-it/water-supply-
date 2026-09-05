'use strict';

/**
 * Removes customer-generated data so the apps show only real activity.
 *
 *   npm run db:clean          preview what would be deleted
 *   npm run db:clean -- --yes actually delete
 *
 * Deletes: customer accounts and everything hanging off them - orders,
 * payments, addresses, notifications, support conversations, OTP challenges.
 *
 * Keeps: products and pricing, admin accounts, drivers, vehicles, service
 * areas, water stations, and the chatbot knowledge base. Those are operator
 * configuration, not activity.
 *
 * Refuses to run against NODE_ENV=production.
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const confirmed = process.argv.includes('--yes') || process.argv.includes('-y');

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run: NODE_ENV=production. This would delete live customer data.');
    process.exitCode = 1;
    return;
  }

  const [customers, orders, payments, addresses, notifications, conversations, otps] = await Promise.all([
    prisma.user.count({ where: { role: 'CUSTOMER' } }),
    prisma.order.count(),
    prisma.payment.count(),
    prisma.address.count(),
    prisma.notification.count(),
    prisma.supportConversation.count(),
    prisma.otpChallenge.count(),
  ]);

  console.log('Will delete:');
  console.log('  customer accounts .......', customers);
  console.log('  orders ..................', orders);
  console.log('  payments ................', payments);
  console.log('  addresses ...............', addresses);
  console.log('  notifications ...........', notifications);
  console.log('  support conversations ...', conversations);
  console.log('  OTP challenges ..........', otps);
  console.log('');
  console.log('Will keep: products, pricing, admins, drivers, vehicles, service areas,');
  console.log('           water stations, chatbot business info.');

  if (!confirmed) {
    console.log('');
    console.log('Preview only. Re-run with --yes to delete:');
    console.log('  npm run db:clean -- --yes');
    return;
  }

  // Order matters only where a cascade does not already cover it. Orders and
  // addresses cascade from User, but payments/events cascade from Order, so
  // deleting users first would leave nothing orphaned either way - we delete
  // explicitly so the counts reported are accurate.
  await prisma.$transaction([
    prisma.supportMessage.deleteMany({}),
    prisma.supportConversation.deleteMany({}),
    prisma.notification.deleteMany({}),
    prisma.orderEvent.deleteMany({}),
    prisma.payment.deleteMany({}),
    prisma.order.deleteMany({}),
    prisma.address.deleteMany({}),
    prisma.otpChallenge.deleteMany({}),
    prisma.user.deleteMany({ where: { role: 'CUSTOMER' } }),
  ]);

  // Drivers keep their profile but should not look mid-delivery afterwards.
  await prisma.driverProfile.updateMany({
    data: { status: 'OFFLINE', currentLat: null, currentLng: null, lastLocationAt: null },
  });

  console.log('');
  console.log('Done. The apps now show only orders placed through the customer app.');
}

main()
  .catch((err) => {
    console.error('Clean failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
