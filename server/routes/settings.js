const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const settingsController = require('../controllers/settingsController');

// Base path: /settings (mounted in index.js)
router.get('/settings', auth, settingsController.getSettings);
// If your updateSettings route exists elsewhere (e.g. admin router), no change needed.

module.exports = router;
