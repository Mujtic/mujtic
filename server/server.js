require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('./config');
const { connectDB } = require('./config/db');
const { connectRedis, disconnectRedis } = require('./config/redis');
const { logger } = require('./config/logger');

// ── Ensure required directories exist ──
// dataDir only. uploadDir was removed when the image pipeline moved to
// Cloudflare R2 — nothing writes to a local uploads folder anymore.
// dataDir is kept because other parts of the app (e.g. logger) may still
// write local files there. Verify with:
//   grep -rn "config.dataDir" server/ --include="*.js"
// If the only hit is this file, delete the whole block.
[config.dataDir].forEach((dir) => {
  if (!dir) return;
  const resolved = path.isAbsolute(dir) ? dir : path.resolve(__dirname, dir);
  if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
});

// ── Validate PORT before listen() ──
// app.listen(undefined) → random port; app.listen('abc') → Unix socket at ./abc.
// Both are silent footguns. Fail loud with a clear message.
const rawPort = process.env.PORT || config.port;
const PORT = Number(rawPort);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  logger.error(`❌ Invalid PORT: "${rawPort}" — must be an integer between 1 and 65535`);
  process.exit(1);
}

let server = null;
let shuttingDown = false;

const startServer = async () => {
  try {
    await connectDB();
    logger.info('✅ Database connected');

    // Redis is a hard dependency in production: rate limiters depend on it
    // to enforce limits across every instance. If REDIS_URL is missing or
    // wrong, connectRedis() throws and the outer catch exits(1) rather than
    // running with silently-broken rate limiting.
    await connectRedis();
    logger.info('✅ Redis connected');

    // ⚠️ app is required HERE — AFTER connectRedis() — not at the top of the
    // file. middleware/rateLimit.js calls getRedisClient() at module load to
    // build its stores; if that runs before Redis is connected, every limiter
    // falls back to the in-memory store and the migration has zero effect on
    // cross-instance rate limiting.
    const app = require('./app');

    server = app.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`);
      logger.info(`📡 Environment: ${process.env.NODE_ENV}`);
      logger.info(`🌐 URL: http://localhost:${PORT}`);
      logger.info(`📦 Node ${process.version} | ${process.platform}`);
    });

    // Handle listen() errors explicitly — EADDRINUSE emits 'error' asynchronously,
    // and without this listener it becomes an uncaughtException (confusing logs).
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        logger.error(`❌ Port ${PORT} is already in use`);
      } else {
        logger.error('❌ HTTP server error', { err: err.message, code: err.code });
      }
      process.exit(1);
    });
  } catch (error) {
    logger.error('❌ Failed to start server', { err: error.message, stack: error.stack });
    process.exit(1);
  }
};

const gracefulShutdown = async (signal, exitCode = 0) => {
  if (shuttingDown) return;   // ignore repeated signals
  shuttingDown = true;

  logger.warn(`⚠️ Received ${signal}, shutting down gracefully...`);

  // Force exit if shutdown hangs; unref so it doesn't keep the process alive
  setTimeout(() => {
    logger.error('❌ Force closing connections after 10s timeout');
    process.exit(1);
  }, 10000).unref();

  try {
    if (server) {
      await new Promise((resolve) => {
        server.close(resolve);
        // Close idle keep-alive connections immediately — nothing to wait for.
        if (typeof server.closeIdleConnections === 'function') {
          server.closeIdleConnections();
        }
        // For active connections, give 5s to finish their current request,
        // then force-close. Keeps total shutdown under the 10s force-exit timer.
        setTimeout(() => {
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
        }, 5000).unref();
      });
      logger.info('✅ HTTP server closed');
    }

    await mongoose.connection.close();
    logger.info('✅ Database connection closed');

    // Redis is closed last: nothing is arriving (HTTP server closed) and
    // nothing is writing to Mongo (closed above). Any in-flight middleware
    // that touched Redis during shutdown will have already completed.
    await disconnectRedis();
    logger.info('✅ Shutdown complete');
  } catch (err) {
    logger.error('❌ Error during shutdown', { err: err.message });
    exitCode = 1;
  }

  process.exit(exitCode);
};

// ── Process event handlers ──

process.on('unhandledRejection', (reason) => {
  // Rejections are contained in a promise — process state is usually OK.
  // Graceful shutdown gives us a chance to clean up before exit.
  logger.error('💥 Unhandled Rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  gracefulShutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (error) => {
  // Cannot safely perform async work after an uncaught exception — the process
  // is in an undefined state. Log and hard-exit. Attempting graceful shutdown
  // here (server.close, DB close) can corrupt state further.
  logger.error('💥 Uncaught Exception — exiting immediately', {
    err: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

startServer();
