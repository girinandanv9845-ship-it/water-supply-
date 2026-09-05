'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const { env } = require('./config/env');
const { pingDatabase } = require('./config/db');
const { apiLimiter } = require('./middleware/rateLimit');
const { errorHandler, notFoundHandler } = require('./middleware/error');

const authRoutes = require('./routes/auth.routes');
const catalogRoutes = require('./routes/catalog.routes');
const addressRoutes = require('./routes/address.routes');
const orderRoutes = require('./routes/order.routes');
const paymentRoutes = require('./routes/payment.routes');
const driverRoutes = require('./routes/driver.routes');
const adminRoutes = require('./routes/admin.routes');
const chatRoutes = require('./routes/chat.routes');
const notificationRoutes = require('./routes/notification.routes');

function createApp() {
  const app = express();

  if (env.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  /**
   * CSP is written explicitly rather than disabled, because the client loads
   * Google Maps, Razorpay checkout and Socket.IO from known origins.
   */
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            "'unsafe-inline'",
            'https://maps.googleapis.com',
            'https://maps.gstatic.com',
            // Razorpay checkout pulls a risk-detection bundle from cdn.razorpay.com
            // at runtime; without it here, live payments fail on a CSP violation.
            'https://checkout.razorpay.com',
            'https://cdn.razorpay.com',
            'https://cdn.jsdelivr.net',
          ],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          imgSrc: ["'self'", 'data:', 'blob:', 'https://maps.googleapis.com', 'https://maps.gstatic.com', 'https://*.googleapis.com', 'https://*.ggpht.com'],
          connectSrc: [
            "'self'",
            'ws:',
            'wss:',
            'https://maps.googleapis.com',
            'https://lumberjack.razorpay.com',
            'https://api.razorpay.com',
            'https://cdn.razorpay.com',
          ],
          frameSrc: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(
    cors({
      origin: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : true,
      credentials: true,
    })
  );

  app.use(compression());
  app.use(cookieParser());

  // Keep the raw body for the Razorpay webhook HMAC check.
  app.use(
    express.json({
      limit: '200kb',
      verify: (req, res, buf) => {
        if (req.originalUrl === '/api/payments/webhook') req.rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  /* ---------------- health ---------------- */

  app.get('/api/health', async (req, res) => {
    const dbUp = await pingDatabase();
    return res.status(dbUp ? 200 : 503).json({
      success: dbUp,
      data: {
        status: dbUp ? 'ok' : 'degraded',
        database: dbUp ? 'connected' : 'unreachable',
        demoMode: env.DEMO_MODE,
        razorpay: env.RAZORPAY_ENABLED ? 'live' : 'demo',
        ai: env.AI_ENABLED ? env.AI_PROVIDER : 'fallback',
        maps: env.MAPS_ENABLED ? 'enabled' : 'disabled',
        uptimeSeconds: Math.round(process.uptime()),
      },
    });
  });

  /* ---------------- api ---------------- */

  app.use('/api', apiLimiter);

  app.use('/api/auth', authRoutes);
  app.use('/api', catalogRoutes);
  app.use('/api/addresses', addressRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/driver', driverRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/notifications', notificationRoutes);

  /* ---------------- static client ---------------- */

  const clientDir = path.join(__dirname, '..', 'client');
  app.use(express.static(clientDir, { maxAge: env.IS_PROD ? '1h' : 0, index: 'index.html' }));

  // Friendly aliases so /admin and /driver work without the .html suffix.
  app.get('/admin', (req, res) => res.sendFile(path.join(clientDir, 'admin.html')));
  app.get('/driver', (req, res) => res.sendFile(path.join(clientDir, 'driver.html')));
  app.get('/track/:orderId', (req, res) => res.sendFile(path.join(clientDir, 'index.html')));

  /* ---------------- errors ---------------- */

  app.use('/api', notFoundHandler);
  app.use((req, res) => res.status(404).sendFile(path.join(clientDir, 'index.html')));
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
