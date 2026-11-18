const express = require('express');
const { setupMiddleware } = require('./config/middleware');
const routes = require('./routes');
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
setupMiddleware(app);

// ── 2. Health checks ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/health/ready', async (req, res) => {
  const mongoose = require('mongoose');
  const dbReady = mongoose.connection.readyState === 1;
  if (!dbReady) {
    return res.status(503).json({ status: 'not ready', db: 'disconnected' });
  }
  res.json({ status: 'ready', db: 'connected', timestamp: new Date().toISOString() });
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
