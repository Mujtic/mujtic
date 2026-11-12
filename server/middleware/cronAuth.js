const { AppError } = require('../utils/appError');

// Allow cron endpoints to be hit by:
//   (a) an authenticated admin (req.user.isAdmin === true), or
//   (b) a scheduler sending the correct X-Cron-Secret header.
// Must run AFTER optionalAuth so req.user is populated when a JWT is present.
module.exports = function requireCronSecretOrAdmin(req, res, next) {
  const provided = req.get('x-cron-secret') || '';
  const expected = process.env.CRON_SECRET || '';

  // Constant-time compare to avoid leaking the secret via timing.
  const crypto = require('crypto');
  const safe = (a, b) => {
    if (!a || !b) return false;
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  };

  if (expected && safe(provided, expected)) return next();
  if (req.user && req.user.isAdmin)        return next();

  return next(new AppError('Forbidden', 403));
};
