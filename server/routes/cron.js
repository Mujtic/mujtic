const express = require('express');
const router = express.Router();
const cronController = require('../controllers/cronController');
const optionalAuth = require('../middleware/optionalAuth');
const requireCronSecretOrAdmin = require('../middleware/cronAuth');

// ── Scheduled jobs ──
// optionalAuth: lets a scheduler call without a JWT, while still populating
// req.user when an admin hits it from the browser.
// requireCronSecretOrAdmin: 403s anything that is neither an admin nor
// carrying the correct X-Cron-Secret. Without this, the endpoint would let
// anyone on the internet trigger bulk user anonymization.
router.post(
  '/cron/process-deletions',
  optionalAuth,
  requireCronSecretOrAdmin,
  cronController.processScheduledDeletions
);

module.exports = router;
