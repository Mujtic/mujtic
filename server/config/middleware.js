// config/middleware.js
const express = require('express');
const cors = require('cors');
const helmet = require('./helmet');
const { logger } = require('./logger');
const { corsOptions } = require('./cors');
const { requestLogger } = require('../middleware/requestLogger');
const { apiLimiter } = require('../middleware/rateLimit');
const { ddosProtection } = require('../middleware/slowDown');

const setupMiddleware = (app) => {
  // ── Trust proxy ──
  // Express's `true` setting trusts ALL X-Forwarded-For hops, which lets an
  // attacker prepend their own value and spoof req.ip — bypassing every
  // IP-based rate limiter. Only hop count is safe. Fail loud if misconfigured.
  const tp = process.env.TRUST_PROXY;
  if (tp !== undefined && tp !== '') {
    if (tp === 'true') {
      throw new Error(
        'TRUST_PROXY=true is unsafe (allows X-Forwarded-For spoofing). ' +
        'Set a numeric hop count instead: 1 for one proxy, 2 for two, etc.'
      );
    }
    const hops = Number(tp);
    if (!Number.isInteger(hops) || hops < 0) {
      throw new Error(`TRUST_PROXY must be a non-negative integer (got "${tp}")`);
    }
    app.set('trust proxy', hops);
  }

  app.use(helmet);
  app.use(cors(corsOptions));

  // requestLogger runs before body parsers so it captures malformed-JSON
  // requests too (body-parser errors happen before any app-level middleware
  // that runs later). It only reads req.originalUrl/method/ip, and reads
  // req.user at res.on('finish') time — by which point auth middleware has
  // already populated it.
  app.use(requestLogger);

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // ── /uploads static mount removed ──
  // Event images now live on Cloudflare R2 (services/storageService.js) and
  // are served via the bucket's public CDN URL, not from this server.
  // Anything that still tries to load /uploads/* will 404 — which is
  // correct, because nothing writes to that directory anymore.
  //
  // Cleanup: the old uploads/ folder can be deleted from the repo. Anything
  // that was in it is already gone (Render's filesystem is ephemeral, so it
  // was wiped on every redeploy anyway).

  // Rate limits must run after body parsers (authLimiter/resetLimiter read
  // req.body in their keyGenerators). They run before routes so requests
  // never reach controllers when the limiter blocks.
  app.use('/api', ddosProtection, apiLimiter);

  // Routes and error handlers are mounted by app.js — do NOT add them here.
  // `upload` was previously returned for callers that needed it, but every
  // caller imports from '../config/multer' directly. Removed.
};

module.exports = { setupMiddleware };
