const express = require('express');
const mongoose = require('mongoose');
const { setupMiddleware } = require('./config/middleware');
const routes = require('./routes');
const { getRedisStatus } = require('./config/redis');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

// ── Paystack webhook: raw body BEFORE any JSON parser ──
// Paystack signs the raw request body with PAYSTACK_SECRET_KEY. If
// express.json() consumes the stream first, the signature won't match.
// Mounted here — before setupMiddleware — so it bypasses the global parser.
app.post(
  '/api/payments/paystack/webhook',
  express.raw({ type: 'application/json', limit: '500kb' }),
  require('./controllers/paymentController').webhook
);

// ── 1. Pre-route middleware ──
// Order matters: helmet → cors → requestLogger → body parsers → rate limiters.
// See config/middleware.js for the full chain.
setupMiddleware(app);

// ── 2. Health checks ──
// Mounted BEFORE routes so a broken route never blocks the health check.
// Both skip rate limiters (via prefix: they're mounted at /api, health is
// at the root, so `apiLimiter` never touches them).

// Liveness: is the process alive?
// MUST NOT check dependencies — a DB or Redis blip would otherwise cause k8s
// to restart the pod repeatedly, making the outage worse. Only the fact that
// we can respond is checked.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Readiness: can we serve real traffic?
// Checks DB connectivity. Returns 503 when the DB is down so k8s/load
// balancers stop routing traffic to this pod — but DOES NOT trigger a
// restart (that's liveness's job).
//
// Redis is reported but does NOT gate readiness. Redis powers rate limiting
// and caching — a Redis blip degrades performance but doesn't break the app,
// so we don't want to remove this pod from rotation over it. The `redis`
// field in the response lets you spot an outage without grepping logs.
app.get('/health/ready', async (req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  const redisStatus = getRedisStatus();

  if (!dbReady) {
    return res.status(503).json({
      status: 'not ready',
      db: 'disconnected',
      redis: redisStatus,
    });
  }

  res.json({
    status: 'ready',
    db: 'connected',
    redis: redisStatus,   // 'connected' | 'connecting' | 'reconnecting' | 'disconnected'
    timestamp: new Date().toISOString(),
  });
});

// ── 3. Routes ──
app.use('/api', routes);

// ── 4. Error handlers (must be last) ──
// Render is API-only — the branded 404.html lives in frontend/ and is
// served by Netlify at the publish root, not here. Unmatched requests
// get the standard JSON AppError shape.
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
