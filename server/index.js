'use strict';

const http = require('http');
const { env, validateEnv } = require('./config/env');
const { createApp } = require('./app');
const { connectDatabase, disconnectDatabase } = require('./config/db');
const { initSockets } = require('./sockets');
const { purgeExpiredOtps } = require('./services/otp.service');
const logger = require('./utils/logger');

async function main() {
  const { errors, warnings } = validateEnv();

  warnings.forEach((w) => logger.warn(w));
  if (errors.length) {
    errors.forEach((e) => logger.error(e));
    logger.error('Startup aborted. Fix the configuration above and try again.');
    process.exit(1);
  }

  // A database outage degrades the app; it does not prevent it from booting.
  await connectDatabase();

  const app = createApp();
  const server = http.createServer(app);
  initSockets(server);

  // Housekeeping: expired OTP challenges, hourly.
  const otpTimer = setInterval(purgeExpiredOtps, 60 * 60 * 1000);
  otpTimer.unref();

  server.listen(env.PORT, () => {
    logger.info(`AquaFlow API listening on http://localhost:${env.PORT}`);
    logger.info(`  customer  http://localhost:${env.PORT}/`);
    logger.info(`  admin     http://localhost:${env.PORT}/admin`);
    logger.info(`  driver    http://localhost:${env.PORT}/driver`);
    logger.info(
      `  mode=${env.NODE_ENV} demo=${env.DEMO_MODE} payments=${env.RAZORPAY_ENABLED ? 'razorpay' : 'demo'} ai=${env.AI_ENABLED ? env.AI_PROVIDER : 'fallback'} maps=${env.MAPS_ENABLED}`
    );
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${env.PORT} is already in use. Set PORT in .env or stop the other process.`);
      process.exit(1);
    }
    logger.error(`HTTP server error: ${err.message}`);
  });

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    clearInterval(otpTimer);
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    // Do not hang forever on lingering sockets.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A stray rejection must be logged, not silently swallowed or fatal.
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled promise rejection: ${reason && reason.message ? reason.message : reason}`);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error(`Fatal startup error: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
