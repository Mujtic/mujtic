// routes/payments.js
const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const optionalAuth = require('../middleware/optionalAuth');

// Webhook is mounted in app.js (before express.json) — not here.
// If you add it here, signature verification breaks because the JSON
// body parser will have already consumed the raw stream.

router.post('/payments/initialize', optionalAuth, paymentController.initialize);
router.get('/payments/verify/:reference', paymentController.verify);

module.exports = router;
