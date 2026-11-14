// middleware/rateLimit.js
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { logger } = require('../config/logger');

// ============================================================
// 1. HELPER: Get username from request body
//    Extracts email or username for key generation
// ============================================================
const getUsername = (req) => req.body?.email || req.body?.username || null;

// Real client IP — respects trust proxy via req.ip.
const clientIp = (req) => {
  const ip = req.ip ?? req.socket?.remoteAddress;
  return ip ? ipKeyGenerator(ip) : 'unknown';
};

// Shared handler: logs the block AND returns the standard error shape used
// everywhere else in the app ({ success: false, message }). Without this, the
// limiter would return { error: '...' }, which no other endpoint produces.
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
  //
  // Authenticated endpoints (e.g. /change-password) don't have an email in
  // the body, but the auth middleware has populated req.user — the key
  // generator below handles those, so we don't want to skip them here.
  skip: (req) => !req.user && !getUsername(req),

  keyGenerator: (req) => {
    // Prefer req.user.email (set by auth middleware on authenticated routes
    // like /change-password). This avoids the 'anon' bucket collision where
    // every user behind the same NAT would share one rate-limit counter.
    // Falls back to body for unauthenticated endpoints (/login, /register).
    const identifier = req.user?.email || getUsername(req) || 'anon';
    return `auth_${identifier}_${clientIp(req)}`;
  },
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

  // Key on IP only — the whole point is to cap total account creation from
  // one source regardless of email. 3/hour is generous for shared NAT (office,
  // café, campus WiFi) while stopping bot bulk-creation cold.
  keyGenerator: (req) => clientIp(req),
});

// ============================================================
// 7. SUBMIT LIMITER (Protects the public support form from spam)
//    Tighter than the global apiLimiter: 5 submissions per IP per hour.
//    Real users file 1-2 tickets, a spammer fills the collection.
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
});


// ============================================================
// 8. CHAT LIMITERS
//    The visitor widget polls GET /chat/:id every 3s while open,
//    and the owner inbox polls GET /chat/conversations/:id every
//    4s. Both would consume the entire apiLimiter budget alone
//    (300/15min = one poll every 3s exactly). Chat is therefore
//    skipped from apiLimiter (see skip below) and covered by
//    these two dedicated buckets instead.
// ============================================================

// Writes — sending a message. Generous enough for a real
// conversation (4 messages/min), tight enough to stop spam floods.
const chatWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,

  standardHeaders: true,
  legacyHeaders: false,

  message: 'Too many chat messages. Please wait a moment.',
  handler: buildHandler('chat-write'),

  keyGenerator: (req) => clientIp(req),
});

// Reads — polling. This is a DDoS ceiling, not a throttle. A
// normal open panel at 3s polling generates 300/15min; two tabs
// is 600. The limit only fires on real abuse (scripted floods).
const chatPollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 2000,

  standardHeaders: true,
  legacyHeaders: false,

  message: 'Too many chat requests. Please slow down.',
  handler: buildHandler('chat-poll'),

  keyGenerator: (req) => clientIp(req),
});

// ============================================================
// 6. EXPORT
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
