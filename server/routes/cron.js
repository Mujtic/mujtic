const express = require('express');
const router = express.Router();
const cronController = require('../controllers/cronController');
const optionalAuth = require('../middleware/optionalAuth');
const requireCronSecretOrAdmin = require('../middleware/cronAuth');

// ── Scheduled jobs ──
// Both endpoints use the same auth gate: X-Cron-Secret header or admin JWT.
// optionalAuth populates req.user when a JWT is present; requireCronSecretOrAdmin
// then allows either path through.

router.post(
  '/cron/process-deletions',
  optionalAuth,
  requireCronSecretOrAdmin,
  cronController.processScheduledDeletions
);

router.post(
  '/cron/publish-events',
  optionalAuth,
  requireCronSecretOrAdmin,
  cronController.publishScheduledEvents
);

module.exports = router;
