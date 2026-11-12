const express = require('express');
const router = express.Router();
const newsletterController = require('../controllers/newsletterController');
const { submitLimiter } = require('../middleware/rateLimit');

// ── Public endpoints ──
// subscribe: 5/hour/IP via submitLimiter — matches the same abuse profile as
// the service-request form. A bot can't generate more than 5 signups per hour
// from one IP. Real users submit 1 at most.
router.post(
  '/newsletter/subscribe',
  submitLimiter,
  newsletterController.subscribe
);

// unsubscribe: hit by the user clicking the link in any newsletter email.
// No rate limiter — the token itself is the credential (32 random bytes).
// GET (not POST) because email clients can only render links, not form posts.
router.get(
  '/newsletter/unsubscribe/:token',
  newsletterController.unsubscribePage
);

module.exports = router;
