const express = require('express');
const { setupMiddleware } = require('./config/middleware');
const routes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

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
