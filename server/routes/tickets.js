const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticketController');
const staffController  = require('../controllers/staffController');
const auth = require('../middleware/auth');
const optionalAuth = require('../middleware/optionalAuth');
const { requireOrganizerOrStaff } = require('../middleware/rbac');

// ── Public / guest-allowed ──
// optionalAuth uses the same verification as auth.js (suspended, passwordChangedAt,
// staff status), but allows guests through with req.user = null. Suspended users
// with valid tokens are still rejected — they can't bypass suspension by hitting
// a guest endpoint.

// Checkout price (ticket price, discounts, service fee, total). Read-only:
// reserves nothing and uses up no promo code. Same pricing as the purchase.
router.post('/tickets/quote', optionalAuth, ticketController.quote);

router.post('/tickets/purchase', optionalAuth, ticketController.purchase);

// ── Authenticated ──
router.get('/tickets/my', auth, ticketController.getMyTickets);

// ── Scan log / stats / search — organizer or staff only ──
// Role gate at the route layer so a customer gets a clean 403 instead of a
// 200-with-empty-array (from getScanLogs) or a confusing service-layer 403
// (from searchTickets). The service still enforces per-event ownership.
//
// Route order: specific paths before :id-style routes so /tickets/search
// doesn't collide with /tickets/:id.
router.get('/tickets/validations',
  auth, requireOrganizerOrStaff, staffController.getScanLogs);

router.get('/tickets/checkin-stats',
  auth, requireOrganizerOrStaff, staffController.getCheckinStats);

router.get('/tickets',
  auth, requireOrganizerOrStaff, ticketController.getEventTickets
);

router.get('/tickets/search',
  auth, requireOrganizerOrStaff, staffController.searchTickets);

// ── Ticket validation (scan) ──
// Accepts both user tokens (organizer scanning their own event) and staff
// tokens (staff scanning their assigned event). The controller resolves the
// acting organizer from req.user and calls staffService.validateTicket.
router.patch('/tickets/:ticketId/validate',
  auth, requireOrganizerOrStaff, staffController.validateTicket);

// Note: removed `POST /tickets/validate` — that route was dead after
// ticketController.validateTicket was refactored to read req.params.id
// (no :id on POST /tickets/validate → always 400).
// Admin manual validation uses PATCH /admin/tickets/:id/validate.

module.exports = router;
