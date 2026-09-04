'use strict';

const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient({
  log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

/**
 * The app must not crash when the database is unavailable - it starts, serves a
 * degraded health endpoint, and keeps retrying in the background.
 */
let connected = false;

async function connectDatabase({ retries = 5, delayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await prisma.$connect();
      await prisma.$queryRaw`SELECT 1`;
      connected = true;
      logger.info('PostgreSQL connected');
      return true;
    } catch (err) {
      connected = false;
      logger.error(
        `PostgreSQL connection failed (attempt ${attempt}/${retries}): ${err.message}`
      );
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  logger.error(
    'Could not reach PostgreSQL. The API will return 503 for database routes until it recovers.'
  );
  return false;
}

function isDatabaseConnected() {
  return connected;
}

async function pingDatabase() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    connected = true;
    return true;
  } catch {
    connected = false;
    return false;
  }
}

async function disconnectDatabase() {
  try {
    await prisma.$disconnect();
  } catch {
    /* shutting down anyway */
  }
}

module.exports = {
  prisma,
  connectDatabase,
  disconnectDatabase,
  isDatabaseConnected,
  pingDatabase,
};
