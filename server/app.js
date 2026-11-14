const express = require('express');
const path = require('path');                                       // ← ADD
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

// ── 4a. Branded 404 for browser navigations ──
// Browsers hitting an unknown URL get the MUJTIC 404.html. API clients,
// fetch(), curl, and asset requests still fall through to notFoundHandler
// below and get the JSON AppError they expect.
app.use((req, res, next) => {
  // Never serve the HTML page for API or asset paths — those want JSON.
  if (
    req.path.startsWith('/api')     ||
    req.path.startsWith('/uploads') ||
    req.path === '/health'          ||
    req.path.startsWith('/health/')
  ) return next();

  // Only browsers (Accept: text/html) get HTML. A fetch() without that
  // header keeps the JSON contract.
  if (!req.accepts('html')) return next();

  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ── 4b. JSON 404 + error handler (must be last) ──
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
