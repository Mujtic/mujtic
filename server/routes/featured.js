// routes/featured.js
const express = require('express');
const router = express.Router();
const featuredController = require('../controllers/featuredController');
const { cache } = require('../middleware/cache');

// Public: feeds the homepage carousel. Cached 60s — it changes only when an
// admin toggles isFeatured, which is far less frequently than the carousel
// is loaded. The admin path invokes the featured controller directly (not
// through this route), so its mutations aren't blocked by this cache.
router.get('/events/featured', cache(60), featuredController.getFeatured);

module.exports = router;
