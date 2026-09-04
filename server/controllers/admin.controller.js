'use strict';

const bcrypt = require('bcryptjs');
const { prisma } = require('../config/db');
const { ApiError, ok, created, asyncHandler } = require('../utils/apiResponse');
const orderService = require('../services/order.service');
const businessInfo = require('../services/businessInfo.service');
const sockets = require('../sockets');

/* ============================ DASHBOARD ============================ */

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const ACTIVE_STATUSES = ['CONFIRMED', 'DRIVER_ASSIGNED', 'DRIVER_ACCEPTED', 'OUT_FOR_DELIVERY', 'ARRIVING'];

/** GET /api/admin/stats */
const stats = asyncHandler(async (req, res) => {
  const today = startOfToday();

  const [
    totalOrders,
    todayOrders,
    pendingOrders,
    activeDeliveries,
    completedOrders,
    cancelledOrders,
    revenueAgg,
    todayRevenueAgg,
    activeDrivers,
    totalDrivers,
    availableVehicles,
    totalVehicles,
    totalCustomers,
  ] = await Promise.all([
    prisma.order.count(),
    prisma.order.count({ where: { createdAt: { gte: today } } }),
    prisma.order.count({ where: { status: { in: ['PENDING', 'PAYMENT_FAILED'] } } }),
    prisma.order.count({ where: { status: { in: ACTIVE_STATUSES } } }),
    prisma.order.count({ where: { status: 'DELIVERED' } }),
    prisma.order.count({ where: { status: { in: ['CANCELLED', 'FAILED'] } } }),
    prisma.payment.aggregate({ _sum: { amountInPaise: true }, where: { status: 'PAID' } }),
    prisma.payment.aggregate({
      _sum: { amountInPaise: true },
      where: { status: 'PAID', paidAt: { gte: today } },
    }),
    prisma.driverProfile.count({ where: { status: { in: ['AVAILABLE', 'ON_DELIVERY'] } } }),
    prisma.driverProfile.count(),
    prisma.vehicle.count({ where: { status: 'ACTIVE' } }),
    prisma.vehicle.count(),
    prisma.user.count({ where: { role: 'CUSTOMER' } }),
  ]);

  // Last 7 days of order volume + revenue, for the dashboard chart.
  const since = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
  const recent = await prisma.order.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true, totalInPaise: true, status: true },
  });

  const series = [];
  for (let i = 6; i >= 0; i -= 1) {
    const day = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const next = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    const dayOrders = recent.filter((o) => o.createdAt >= day && o.createdAt < next);
    series.push({
      date: day.toISOString().slice(0, 10),
      orders: dayOrders.length,
      delivered: dayOrders.filter((o) => o.status === 'DELIVERED').length,
      revenueRupees:
        dayOrders.filter((o) => o.status === 'DELIVERED').reduce((s, o) => s + o.totalInPaise, 0) / 100,
    });
  }

  const byStatus = await prisma.order.groupBy({ by: ['status'], _count: { _all: true } });

  return ok(res, {
    totalOrders,
    todayOrders,
    pendingOrders,
    activeDeliveries,
    completedOrders,
    cancelledOrders,
    totalCustomers,
    revenueRupees: (revenueAgg._sum.amountInPaise || 0) / 100,
    todayRevenueRupees: (todayRevenueAgg._sum.amountInPaise || 0) / 100,
    activeDrivers,
    totalDrivers,
    availableVehicles,
    totalVehicles,
    series,
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
  });
});

/* ============================ ORDERS ============================ */

/** GET /api/admin/orders */
const listOrders = asyncHandler(async (req, res) => {
  const { page, limit, status, search } = req.validatedQuery;

  const where = {};
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { orderNumber: { contains: search, mode: 'insensitive' } },
      { customer: { name: { contains: search, mode: 'insensitive' } } },
      { customer: { phone: { contains: search } } },
      { deliveryAddressText: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [total, orders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      include: orderService.ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return ok(res, orders.map((o) => orderService.serializeOrder(o, { viewerRole: 'ADMIN' })), {
    page,
    limit,
    total,
    pages: Math.ceil(total / limit) || 1,
  });
});

/** GET /api/admin/orders/:id */
const getOrder = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderOr404(req.params.id);
  return ok(res, orderService.serializeOrder(order, { viewerRole: 'ADMIN' }));
});

/** POST /api/admin/orders/:id/assign-driver */
const assignDriver = asyncHandler(async (req, res) => {
  const { driverId, vehicleId } = req.body;

  const [order, driver] = await Promise.all([
    prisma.order.findUnique({ where: { id: req.params.id } }),
    prisma.driverProfile.findUnique({ where: { id: driverId }, include: { user: true } }),
  ]);

  if (!order) throw ApiError.notFound('Order not found.');
  if (!driver) throw ApiError.notFound('Driver not found.');
  if (!driver.isVerified) throw ApiError.badRequest('That driver is not verified yet.');
  if (driver.status === 'SUSPENDED') throw ApiError.badRequest('That driver is suspended.');

  let vehicle = null;
  if (vehicleId) {
    vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle) throw ApiError.notFound('Vehicle not found.');
    if (vehicle.status !== 'ACTIVE') throw ApiError.badRequest('That vehicle is not active.');
    if (vehicle.capacityL < order.quantityL) {
      throw ApiError.badRequest(
        `That tanker holds ${vehicle.capacityL}L but the order needs ${order.quantityL}L.`
      );
    }
  }

  const updated = await orderService.transitionOrder({
    orderId: order.id,
    to: 'DRIVER_ASSIGNED',
    actorRole: 'ADMIN',
    actorId: req.user.id,
    note: `Assigned to ${driver.user.name}${vehicle ? ` with ${vehicle.registrationNumber}` : ''}`,
    extraData: { driverId, vehicleId: vehicleId || null },
  });

  // Push the job straight to the driver's device.
  sockets.emitToDriver(driverId, 'driver:new-assignment', orderService.serializeOrder(updated, { viewerRole: 'DRIVER' }));

  return ok(res, orderService.serializeOrder(updated, { viewerRole: 'ADMIN' }));
});

/** POST /api/admin/orders/:id/status */
const updateOrderStatus = asyncHandler(async (req, res) => {
  const updated = await orderService.transitionOrder({
    orderId: req.params.id,
    to: req.body.status,
    actorRole: 'ADMIN',
    actorId: req.user.id,
    note: req.body.note || `Set by admin`,
    ...(req.body.status === 'CANCELLED'
      ? { extraData: { cancelReason: req.body.note || 'Cancelled by admin' } }
      : {}),
  });
  return ok(res, orderService.serializeOrder(updated, { viewerRole: 'ADMIN' }));
});

/** GET /api/admin/live - active deliveries + driver positions for the live map. */
const liveMap = asyncHandler(async (req, res) => {
  const [orders, drivers] = await Promise.all([
    prisma.order.findMany({
      where: { status: { in: ACTIVE_STATUSES } },
      include: orderService.ORDER_INCLUDE,
      orderBy: { createdAt: 'asc' },
    }),
    prisma.driverProfile.findMany({
      where: { status: { in: ['AVAILABLE', 'ON_DELIVERY'] }, currentLat: { not: null } },
      select: {
        id: true,
        status: true,
        currentLat: true,
        currentLng: true,
        lastLocationAt: true,
        user: { select: { name: true, phone: true } },
      },
    }),
  ]);

  return ok(res, {
    orders: orders.map((o) => orderService.serializeOrder(o, { viewerRole: 'ADMIN' })),
    drivers: drivers.map((d) => ({
      id: d.id,
      name: d.user.name,
      phone: d.user.phone,
      status: d.status,
      latitude: d.currentLat,
      longitude: d.currentLng,
      lastLocationAt: d.lastLocationAt,
    })),
  });
});

/* ============================ DRIVERS ============================ */

const listDrivers = asyncHandler(async (req, res) => {
  const drivers = await prisma.driverProfile.findMany({
    include: {
      user: { select: { id: true, name: true, phone: true, email: true, isActive: true } },
      vehicles: { select: { id: true, registrationNumber: true, capacityL: true, status: true } },
      _count: { select: { orders: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return ok(res, drivers);
});

/** POST /api/admin/drivers - creates the user account and the driver profile. */
const createDriver = asyncHandler(async (req, res) => {
  const { name, phone, email, licenseNumber, isVerified } = req.body;

  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    throw ApiError.conflict('A user with that phone number already exists.');
  }

  const driver = await prisma.driverProfile.create({
    data: {
      licenseNumber: licenseNumber || null,
      isVerified: isVerified !== false,
      status: 'OFFLINE',
      user: { create: { name, phone, email: email || null, role: 'DRIVER' } },
    },
    include: { user: { select: { id: true, name: true, phone: true } } },
  });

  return created(res, driver);
});

const updateDriver = asyncHandler(async (req, res) => {
  const { isVerified, status, licenseNumber, isActive } = req.body;

  const driver = await prisma.driverProfile.findUnique({ where: { id: req.params.id } });
  if (!driver) throw ApiError.notFound('Driver not found.');

  const updated = await prisma.driverProfile.update({
    where: { id: req.params.id },
    data: {
      ...(isVerified !== undefined ? { isVerified } : {}),
      ...(status ? { status } : {}),
      ...(licenseNumber !== undefined ? { licenseNumber: licenseNumber || null } : {}),
      ...(isActive !== undefined ? { user: { update: { isActive } } } : {}),
    },
    include: { user: { select: { id: true, name: true, phone: true, isActive: true } } },
  });
  return ok(res, updated);
});

/* ============================ VEHICLES ============================ */

const listVehicles = asyncHandler(async (req, res) => {
  const vehicles = await prisma.vehicle.findMany({
    include: { driver: { select: { id: true, user: { select: { name: true, phone: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
  return ok(res, vehicles);
});

const createVehicle = asyncHandler(async (req, res) => {
  const vehicle = await prisma.vehicle.create({ data: req.body });
  return created(res, vehicle);
});

const updateVehicle = asyncHandler(async (req, res) => {
  const vehicle = await prisma.vehicle.update({ where: { id: req.params.id }, data: req.body });
  return ok(res, vehicle);
});

/* ============================ PRODUCTS ============================ */

const listProducts = asyncHandler(async (req, res) => {
  const products = await prisma.product.findMany({ orderBy: { sortOrder: 'asc' } });
  return ok(res, products.map((p) => ({ ...p, priceRupees: p.priceInPaise / 100 })));
});

const createProduct = asyncHandler(async (req, res) => {
  const { priceRupees, ...rest } = req.body;
  const product = await prisma.product.create({
    data: { ...rest, priceInPaise: Math.round(priceRupees * 100) },
  });
  return created(res, product);
});

const updateProduct = asyncHandler(async (req, res) => {
  const { priceRupees, ...rest } = req.body;
  const product = await prisma.product.update({
    where: { id: req.params.id },
    data: { ...rest, ...(priceRupees !== undefined ? { priceInPaise: Math.round(priceRupees * 100) } : {}) },
  });
  return ok(res, product);
});

/* ============================ CUSTOMERS ============================ */

const listCustomers = asyncHandler(async (req, res) => {
  const { page, limit, search } = req.validatedQuery;
  const where = { role: 'CUSTOMER' };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search } },
    ];
  }

  const [total, customers] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        isActive: true,
        createdAt: true,
        lastLoginAt: true,
        _count: { select: { customerOrders: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return ok(res, customers, { page, limit, total, pages: Math.ceil(total / limit) || 1 });
});

const updateCustomer = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user || user.role !== 'CUSTOMER') throw ApiError.notFound('Customer not found.');
  const updated = await prisma.user.update({
    where: { id: req.params.id },
    data: { isActive: req.body.isActive },
    select: { id: true, name: true, phone: true, isActive: true },
  });
  return ok(res, updated);
});

/* ============================ PAYMENTS ============================ */

const listPayments = asyncHandler(async (req, res) => {
  const { page, limit, status } = req.validatedQuery;
  const where = status ? { status } : {};

  const [total, payments] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            customer: { select: { name: true, phone: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return ok(
    res,
    payments.map((p) => ({ ...p, amountRupees: p.amountInPaise / 100, signature: undefined })),
    { page, limit, total, pages: Math.ceil(total / limit) || 1 }
  );
});

/* ============================ SERVICE AREAS ============================ */

const listServiceAreas = asyncHandler(async (req, res) =>
  ok(res, await prisma.serviceArea.findMany({ orderBy: { createdAt: 'desc' } }))
);

const createServiceArea = asyncHandler(async (req, res) =>
  created(res, await prisma.serviceArea.create({ data: req.body }))
);

const updateServiceArea = asyncHandler(async (req, res) =>
  ok(res, await prisma.serviceArea.update({ where: { id: req.params.id }, data: req.body }))
);

const deleteServiceArea = asyncHandler(async (req, res) => {
  await prisma.serviceArea.delete({ where: { id: req.params.id } });
  return ok(res, { deleted: true });
});

/* ============================ SETTINGS / CHATBOT ============================ */

const getBusinessInfo = asyncHandler(async (req, res) => ok(res, await businessInfo.getBusinessInfo()));

const updateBusinessInfo = asyncHandler(async (req, res) =>
  ok(res, await businessInfo.updateBusinessInfo(req.body))
);

/** GET /api/admin/support - recent chatbot conversations. */
const listConversations = asyncHandler(async (req, res) => {
  const conversations = await prisma.supportConversation.findMany({
    include: {
      user: { select: { id: true, name: true, phone: true } },
      messages: { orderBy: { createdAt: 'asc' }, take: 50 },
    },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  });
  return ok(res, conversations);
});

/** POST /api/admin/admins - create another admin (password is hashed here). */
const createAdmin = asyncHandler(async (req, res) => {
  const { name, phone, password } = req.body;
  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) throw ApiError.conflict('A user with that phone number already exists.');

  const user = await prisma.user.create({
    data: { name, phone, role: 'ADMIN', passwordHash: await bcrypt.hash(password, 12) },
    select: { id: true, name: true, phone: true, role: true },
  });
  return created(res, user);
});

module.exports = {
  stats,
  listOrders,
  getOrder,
  assignDriver,
  updateOrderStatus,
  liveMap,
  listDrivers,
  createDriver,
  updateDriver,
  listVehicles,
  createVehicle,
  updateVehicle,
  listProducts,
  createProduct,
  updateProduct,
  listCustomers,
  updateCustomer,
  listPayments,
  listServiceAreas,
  createServiceArea,
  updateServiceArea,
  deleteServiceArea,
  getBusinessInfo,
  updateBusinessInfo,
  listConversations,
  createAdmin,
};
