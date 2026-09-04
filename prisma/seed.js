'use strict';

/**
 * Idempotent seed. Safe to run repeatedly - it upserts and never deletes.
 *
 * The admin password comes from ADMIN_SEED_PASSWORD. If that is unset, a random
 * one is generated and printed once; nothing is ever hardcoded.
 */

require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const ADMIN_PHONE = process.env.ADMIN_SEED_PHONE || '9000000001';
const DRIVER_PHONE = process.env.DRIVER_SEED_PHONE || '9000000002';

async function main() {
  console.log('Seeding AquaFlow...');

  /* ---------- products (the two loads from the original app, now editable) ---------- */

  const products = [
    {
      slug: 'half-load',
      name: 'Half Load',
      description: 'Ideal for a small household or a top-up.',
      capacityL: 2000,
      priceInPaise: 30000, // Rs 300
      vehicleType: 'TANKER',
      sortOrder: 1,
      imageEmoji: 'H',
    },
    {
      slug: 'full-load',
      name: 'Full Load',
      description: 'Best value. Fills a standard overhead + sump tank.',
      capacityL: 4000,
      priceInPaise: 60000, // Rs 600
      vehicleType: 'TANKER',
      sortOrder: 2,
      imageEmoji: 'F',
    },
    {
      slug: 'bulk-load',
      name: 'Bulk Load',
      description: 'For apartments, construction sites and events.',
      capacityL: 10000,
      priceInPaise: 140000, // Rs 1400
      vehicleType: 'BULK_TANKER',
      sortOrder: 3,
      imageEmoji: 'B',
    },
  ];

  for (const p of products) {
    await prisma.product.upsert({ where: { slug: p.slug }, create: p, update: {} });
  }
  console.log(`  products: ${products.length}`);

  /* ---------- admin ---------- */

  let generatedPassword = null;
  const existingAdmin = await prisma.user.findUnique({ where: { phone: ADMIN_PHONE } });

  if (!existingAdmin) {
    const password = process.env.ADMIN_SEED_PASSWORD || crypto.randomBytes(9).toString('base64url');
    if (!process.env.ADMIN_SEED_PASSWORD) generatedPassword = password;

    await prisma.user.create({
      data: {
        name: 'Operations Admin',
        phone: ADMIN_PHONE,
        role: 'ADMIN',
        passwordHash: await bcrypt.hash(password, 12),
      },
    });
    console.log(`  admin created: ${ADMIN_PHONE}`);
  } else {
    console.log(`  admin already exists: ${ADMIN_PHONE}`);
  }

  /* ---------- a driver + tanker so dispatch can be exercised immediately ---------- */

  let driverUser = await prisma.user.findUnique({
    where: { phone: DRIVER_PHONE },
    include: { driverProfile: true },
  });

  if (!driverUser) {
    driverUser = await prisma.user.create({
      data: {
        name: 'Ravi Kumar',
        phone: DRIVER_PHONE,
        role: 'DRIVER',
        driverProfile: {
          create: { licenseNumber: 'DL-SEED-0001', isVerified: true, status: 'OFFLINE' },
        },
      },
      include: { driverProfile: true },
    });
    console.log(`  driver created: ${DRIVER_PHONE}`);
  } else {
    console.log(`  driver already exists: ${DRIVER_PHONE}`);
  }

  const driverProfileId = driverUser.driverProfile ? driverUser.driverProfile.id : null;

  await prisma.vehicle.upsert({
    where: { registrationNumber: 'KA01AQ1001' },
    create: {
      registrationNumber: 'KA01AQ1001',
      vehicleType: 'TANKER',
      capacityL: 4000,
      status: 'ACTIVE',
      driverId: driverProfileId,
    },
    update: {},
  });
  await prisma.vehicle.upsert({
    where: { registrationNumber: 'KA01AQ1002' },
    create: { registrationNumber: 'KA01AQ1002', vehicleType: 'BULK_TANKER', capacityL: 10000, status: 'ACTIVE' },
    update: {},
  });
  console.log('  vehicles: 2');

  /* ---------- service area ---------- */

  const areaCount = await prisma.serviceArea.count();
  if (areaCount === 0) {
    await prisma.serviceArea.create({
      data: {
        name: 'Bengaluru Central',
        pincode: '560001',
        centerLat: Number(process.env.SEED_AREA_LAT || 12.9716),
        centerLng: Number(process.env.SEED_AREA_LNG || 77.5946),
        radiusKm: Number(process.env.SEED_AREA_RADIUS_KM || 30),
        isActive: true,
      },
    });
    console.log('  service area: Bengaluru Central (30km)');
  }

  /* ---------- chatbot knowledge ---------- */

  const existingInfo = await prisma.setting.findUnique({ where: { key: 'businessInfo' } });
  if (!existingInfo) {
    await prisma.setting.create({
      data: {
        key: 'businessInfo',
        value: {
          companyName: 'AquaFlow Water Supply',
          tagline: 'Clean water delivered to your door',
          supportPhone: process.env.SUPPORT_PHONE || '',
          supportEmail: process.env.SUPPORT_EMAIL || '',
          workingHours: '6:00 AM to 9:00 PM, all days',
          paymentMethods: ['UPI', 'Card', 'Netbanking', 'Wallet', 'Cash on delivery'],
          cancellationPolicy:
            'Free cancellation until a driver accepts your order. After the tanker is on the way, call support.',
          refundPolicy: 'Online payments for cancelled orders are refunded within 5 to 7 working days.',
          deliveryTimeNote: 'Most deliveries arrive within 45 to 90 minutes inside our service area.',
          waterSource: 'Borewell and treated municipal supply, tested for potability.',
          notes: '',
        },
      },
    });
    console.log('  chatbot business info seeded');
  }

  console.log('\nSeed complete.\n');
  console.log('  Admin login  -> /admin      phone: ' + ADMIN_PHONE);
  if (generatedPassword) {
    console.log('  Admin password (shown once, save it): ' + generatedPassword);
    console.log('  Set ADMIN_SEED_PASSWORD in .env to choose your own instead.');
  } else if (process.env.ADMIN_SEED_PASSWORD) {
    console.log('  Admin password -> value of ADMIN_SEED_PASSWORD in your .env');
  }
  console.log('  Driver login -> /driver     phone: ' + DRIVER_PHONE + ' (OTP)');
  console.log('  Customer     -> /           any 10-digit mobile number (OTP)');
  if (process.env.DEMO_MODE !== 'false') {
    console.log('  DEMO_MODE prints the OTP in the server log and returns it in the API response.');
  }
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
