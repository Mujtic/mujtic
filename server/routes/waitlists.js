const express = require('express');
const router = express.Router();
const waitlistController = require('../controllers/waitlistController');
const auth = require('../middleware/auth');
const optionalAuth = require('../middleware/optionalAuth');
const { requireAdmin, requireOrganizer } = require('../middleware/rbac');
const { validate, waitlistSchema } = require('../middleware/validation');

// ── Public / guest-allowed: join waitlist ──
// optionalAuth: allows guests through (req.user = null), but populates req.user
// for logged-in users so joinWaitlist's audit branch fires correctly. Without
// it, logged-in users were silently treated as anonymous — never audited in
// MongoDB, only traced to winston.
//
// Suspended users with old tokens are rejected at optionalAuth (401), so they
// can't bypass suspension by using the guest path.
router.post(
  '/waitlists',
  optionalAuth,
  validate(waitlistSchema),
  waitlistController.joinWaitlist
);

// ── Admin-wide list ──
// Route-level requireAdmin + controller's isAdmin check = defense-in-depth.
// This endpoint returns every waitlist entry across every event (full PII:
// names, emails, phones). If the controller check is ever accidentally
// removed, the route gate still blocks non-admins.
router.get('/waitlists', auth, requireAdmin, waitlistController.getWaitlist);

// ── Organizer: view a specific event's waitlist ──
// requireOrganizer = ['organizer', 'admin'] — excludes staff (waitlist
// management isn't a scanner operation) and customers. The service still
// enforces per-event ownership: an organizer can only view their own events.
router.get(
  '/events/:eventId/waitlists/:ticketType',
  auth,
  requireOrganizer,
  waitlistController.getWaitlist
);

// ── Organizer: notify a specific event's waitlist ──
// Sends up to 200 emails/SMS per call. requireOrganizer gates the route;
// the service enforces ownership + per-entry cooldown. If you start seeing
// Twilio/Resend cost spikes from a single organizer, add a rate limiter
// here (e.g. 5 notify calls per 15 min per organizer).
router.post(
  '/events/:eventId/waitlists/notify',
  auth,
  requireOrganizer,
  waitlistController.notifyWaitlist
);

module.exports = router;
