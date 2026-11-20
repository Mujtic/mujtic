const express = require('express');
const router = express.Router();
const eventController = require('../controllers/eventController');
const auth = require('../middleware/auth');
const { requireOrganizerOnly, requireOrganizer } = require('../middleware/rbac');
const { validate, eventSchema } = require('../middleware/validation');
const { cache } = require('../middleware/cache');

// ── Public: event browsing ──
// Listings cached 30s. Mutation handlers below invalidate the cache.
// GET /events/:id is NOT cached — the detail page is hit far less often and
// a stale detail page is worse than a stale listing.
router.get('/events', cache(30), eventController.getEvents);
router.get('/events/:id', eventController.getEvent);

// ── Organizer-only: event management ──
router.post(
  '/events',
  auth,
  requireOrganizerOnly,
  validate(eventSchema),
  eventController.createEvent
);

router.put(
  '/events/:id',
  auth,
  requireOrganizerOnly,
  validate(eventSchema),
  eventController.updateEvent
);

router.delete(
  '/events/:id',
  auth,
  requireOrganizerOnly,
  eventController.deleteEvent
);

router.patch(
  '/events/:id/publish',
  auth,
  requireOrganizerOnly,
  eventController.togglePublish
);

router.patch('/events/:id/cancel', auth, requireOrganizer, eventController.cancelEvent);

module.exports = router;
