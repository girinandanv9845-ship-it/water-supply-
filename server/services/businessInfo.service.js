'use strict';

const { prisma } = require('../config/db');

/**
 * The single source of truth the chatbot is allowed to speak from.
 * Admin-editable (Setting table) and always merged with live catalog/service-area
 * rows, so prices quoted by the bot cannot drift from what the app charges.
 */

const SETTING_KEY = 'businessInfo';

const DEFAULT_BUSINESS_INFO = {
  companyName: 'AquaFlow Water Supply',
  tagline: 'Clean water delivered to your door',
  supportPhone: '',
  supportEmail: '',
  workingHours: '6:00 AM to 9:00 PM, all days',
  paymentMethods: ['UPI', 'Card', 'Netbanking', 'Wallet', 'Cash on delivery'],
  cancellationPolicy:
    'You can cancel free of charge until a driver has accepted your order. After the tanker is on the way, please call support.',
  deliveryTimeNote: 'Most deliveries reach within 45 to 90 minutes inside our service area, depending on demand.',
  refundPolicy: 'Online payments for cancelled orders are refunded to the original payment method within 5 to 7 working days.',
  waterSource: 'Borewell and treated municipal supply, tested for potability.',
  notes: '',
};

async function getBusinessInfo() {
  const [setting, products, areas] = await Promise.all([
    prisma.setting.findUnique({ where: { key: SETTING_KEY } }).catch(() => null),
    prisma.product.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { name: true, capacityL: true, priceInPaise: true, description: true, vehicleType: true },
    }),
    prisma.serviceArea.findMany({
      where: { isActive: true },
      select: { name: true, pincode: true, radiusKm: true },
    }),
  ]);

  const configured = setting && setting.value ? setting.value : {};

  return {
    ...DEFAULT_BUSINESS_INFO,
    ...configured,
    // Live data always wins over anything stored in settings.
    products: products.map((p) => ({
      name: p.name,
      litres: p.capacityL,
      priceRupees: p.priceInPaise / 100,
      vehicleType: p.vehicleType,
      description: p.description || undefined,
    })),
    serviceAreas: areas.map((a) => ({
      name: a.name,
      pincode: a.pincode || undefined,
      radiusKm: a.radiusKm,
    })),
  };
}

async function updateBusinessInfo(patch) {
  const current = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const merged = { ...(current && current.value ? current.value : DEFAULT_BUSINESS_INFO), ...patch };
  // products/serviceAreas are derived - never persist them into settings.
  delete merged.products;
  delete merged.serviceAreas;

  const saved = await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: merged },
    update: { value: merged },
  });
  return saved.value;
}

module.exports = { getBusinessInfo, updateBusinessInfo, DEFAULT_BUSINESS_INFO, SETTING_KEY };
