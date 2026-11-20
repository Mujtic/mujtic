// middleware/rateLimit.js
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { logger } = require('../config/logger');
const { getRedisClient } = require('../config/redis');

// ============================================================
// 1. HELPERS
// ============================================================
const getUsername = (req) => req.body?.email || req.body?.username || null;

// Real client IP — respects trust proxy via req.ip.
const clientIp = (req) => {
  const ip = req.ip ?? req.socket?.remoteAddress;
  return ip ? ipKeyGenerator(ip) : 'unknown';
};

// Shared handler: logs the block AND returns the standard error shape used
// everywhere else in the app ({ success: false, message }).
const buildHandler = (limiterName) => (req, res, next, options) => {
  logger.warn('Rate limit exceeded', {
    limiter: limiterName,
    ip: req.ip,
    path: req.originalUrl,
    method: req.method,
    userId: req.user?.id || req.user?.staffId || undefined,
  });
  res.status(options.statusCode).json({
    success: false,
    message: String(options.message || 'Too many requests. Please try again later.'),
  });
};

// ── Redis store factory ──
// One unique prefix per limiter. Shared prefixes cross-contaminate counters
// and cause one limiter to trip on another limiter's traffic.
//
// Called at module load. Because server.js requires ./app AFTER connectRedis(),
// getRedisClient() returns a live client by the time this file runs. If Redis
// is somehow unavailable (dev without a local Redis, or the reorder was
// accidentally undone), the warning below tells you exactly what happened.
//
// node-redis v4 API: sendCommand takes the full args array.
// ioredis would use redis.call(...args) instead — different shape.
const makeStore = (prefix) => {
  const client = getRedisClient();
  if (!client) {
    logger.warn(
      `Rate limiter "${prefix}": Redis client unavailable at module load — ` +
      `using in-memory store. Cross-instance rate limiting is DISABLED. ` +
      `Check that server.js requires app AFTER connectRedis().`
    );
    return undefined;
  }
  return new RedisStore({
    sendCommand: (...args) => client.sendCommand(args),
    prefix: `rl:${prefix}:`,
  });
};

// ============================================================
// 2. GLOBAL API LIMITER (Blocks scrapers)
// ============================================================
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'production' ? 300 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests. Please wait.',
  handler: buildHandler('api'),

  // Skip /health and / — and /chat/*. Chat has its own buckets
  // (chatWriteLimiter, chatPollLimiter) because the widget's
  // 3s polling would otherwise exhaust apiLimiter's 300/15min.
  skip: (req) => req.path === '/health' || req.path === '/' || req.path.startsWith('/chat'),

  keyGenerator: (req) => clientIp(req),
  store: makeStore('api'),
});

// ============================================================
// 3. AUTH LIMITER (Blocks brute-force attacks)
// ============================================================
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,

  standardHeaders: true,
  legacyHeaders: false,

  skipSuccessfulRequests: true,

  message: 'Excessive login attempts. Try again later.',
  handler: buildHandler('auth'),

  // If req.body has no identifier AND the user isn't authenticated, the
  // request is malformed for an auth-flow endpoint. Skip the limiter so the
  // 400 from Joi/service fires normally instead of being blocked as 'anon'.
  skip: (req) => !req.user && !getUsername(req),

  keyGenerator: (req) => {
    // Prefer req.user.email (set by auth middleware on authenticated routes
    // like /change-password). This avoids the 'anon' bucket collision where
    // every user behind the same NAT would share one rate-limit counter.
    const identifier = req.user?.email || getUsername(req) || 'anon';
    return `auth_${identifier}_${clientIp(req)}`;
  },
  store: makeStore('auth'),
});

// ============================================================
// 4. RESET LIMITER (Protects email sending budget)
// ============================================================
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,

  standardHeaders: true,
  legacyHeaders: false,

  message: 'Too many reset attempts. Wait an hour.',
  handler: buildHandler('reset'),

  keyGenerator: (req) => {
    const user = getUsername(req) || 'anon';
    return `reset_${user}_${clientIp(req)}`;
  },
  store: makeStore('reset'),
});

// ============================================================
// 5. REGISTER LIMITER (Blocks bulk account creation)
//    Distinct from authLimiter, which keys on (email, IP) and skips
//    successes — a bot using unique emails bypasses it. This one keys on
//    IP only, regardless of how many different emails they try.
// ============================================================
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,

  standardHeaders: true,
  legacyHeaders: false,

  message: 'Too many accounts created from this IP. Try again later.',
  handler: buildHandler('register'),

  keyGenerator: (req) => clientIp(req),
  store: makeStore('register'),
});

// ============================================================
// 6. SUBMIT LIMITER (Protects the public support form from spam)
//    Tighter than the global apiLimiter: 5 submissions per IP per hour.
// ============================================================
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,

  standardHeaders: true,
  legacyHeaders: false,

  message: 'Too many support requests. Please wait before submitting another.',
  handler: buildHandler('submit'),

  // IPv6-safe — MUST use ipKeyGenerator, otherwise express-rate-limit v7
  // throws ERR_ERL_KEY_GEN_IPV6 at module load.
  keyGenerator: (req) => clientIp(req),
  store: makeStore('submit'),
});

// ============================================================
// 7. CHAT WRITE LIMITER (Sending a chat message)
//    Generous enough for a real conversation (4 messages/min),
//    tight enough to stop spam floods.
// ============================================================
const chatWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,

  standardHeaders: true,
  legacyHeaders: false,

  message: 'Too many chat messages. Please wait a moment.',
  handler: buildHandler('chat-write'),

  keyGenerator: (req) => clientIp(req),
  store: makeStore('chat-write'),
});

// ============================================================
// 8. CHAT POLL LIMITER (Polling — reads only)
//    A DDoS ceiling, not a throttle. A normal open panel at 3s
//    polling generates 300/15min; two tabs is 600. The limit
//    only fires on real abuse (scripted floods).
// ============================================================
const chatPollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 2000,

  standardHeaders: true,
  legacyHeaders: false,

  message: 'Too many chat requests. Please slow down.',
  handler: buildHandler('chat-poll'),

  keyGenerator: (req) => clientIp(req),
  store: makeStore('chat-poll'),
});

// ============================================================
// 9. EXPORTS
// ============================================================
module.exports = {
  apiLimiter,
  authLimiter,
  resetLimiter,
  registerLimiter,
  submitLimiter,
  chatWriteLimiter,
  chatPollLimiter,
};
