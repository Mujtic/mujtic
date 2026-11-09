const express = require('express');
const router = express.Router();

const adminController = require('../controllers/adminController');
const settingsController = require('../controllers/settingsController');
const ticketController = require('../controllers/ticketController');
const logController = require('../controllers/logController');
const refundController = require('../controllers/refundController');
const serviceRequestController = require('../controllers/serviceRequestController');
const featuredController = require('../controllers/featuredController');

const auth = require('../middleware/auth');
const { requireAdmin, requireModeratorOrAdmin } = require('../middleware/rbac');
const { validate, convertWaitlistSchema } = require('../validators');

// Every /admin/* route is authenticated here. Role gates per-route below.
router.use('/admin', auth);

// ── Dashboard ──
router.get('/admin/stats', requireModeratorOrAdmin, adminController.getStats);

// ── Users ──
// Moderators can list and suspend (service blocks them from suspending admins/mods).
// Everything else (create, edit, role, delete) is admin-only.
router.get('/admin/users', requireModeratorOrAdmin, adminController.getAllUsers);
router.patch('/admin/users/:id/suspend', requireModeratorOrAdmin, adminController.suspendUser);
router.post('/admin/users', requireAdmin, adminController.createUser);
router.put('/admin/users/:id', requireAdmin, adminController.updateUser);
router.patch('/admin/users/:id/role', requireAdmin, adminController.changeUserRole);
router.delete('/admin/users/:id', requireAdmin, adminController.deleteUser);

// ── Waitlist ──
// Moderators can view and notify (SMS budget is real but bounded by NOTIFY_COOLDOWN).
// Converting creates a PAID ticket — the admin records the out-of-band payment
// (gateway ref / MoMo receipt / bank ref) at conversion time, so this is
// financial and admin-only. The validation schema requires paymentReference
// and paymentGateway; the service applies the current fee rates and freezes
// them onto the ticket, same as a normal checkout.
// Deleting removes someone from the queue — admin-only (destructive).
router.get('/admin/waitlists', requireModeratorOrAdmin, adminController.getAllWaitlists);
router.post('/admin/waitlist/:id/notify', requireModeratorOrAdmin, adminController.notifyWaitlistEntry);
router.post(
  '/admin/waitlist/:id/convert',
  requireAdmin,
  validate(convertWaitlistSchema),
  adminController.convertWaitlistToTicket
);
router.delete('/admin/waitlist/:id', requireAdmin, adminController.deleteWaitlistEntry);

// ── Events ──
// All event moderation is moderator territory. Delete cascades to tickets /
// favorites / waitlists / refunds — admin-only. Publish/unpublish lets a
// moderator hide a suspicious event without destroying data.
router.get('/admin/events', requireModeratorOrAdmin, adminController.getAllEvents);
router.patch('/admin/events/:id/flag', requireModeratorOrAdmin, adminController.flagEvent);
router.patch('/admin/events/:id/unflag', requireModeratorOrAdmin, adminController.unflagEvent);
router.patch('/admin/events/:id/publish', requireModeratorOrAdmin, adminController.togglePublish);
router.delete('/admin/events/:id', requireAdmin, adminController.deleteEvent);
router.patch('/admin/events/:id/cancel',  requireModeratorOrAdmin, adminController.cancelEvent);
router.patch('/admin/events/:id/restore', requireModeratorOrAdmin, adminController.restoreEvent);

// ── Tickets ──
// Listing is moderator-visible. Validate/cancel affect ticket state and
// trigger refunds — admin-only (the ticket service also has an isAdmin guard).
router.get('/admin/tickets', requireModeratorOrAdmin, adminController.getAllTickets);
router.patch('/admin/tickets/:id/validate', requireAdmin, ticketController.validateTicket);
router.patch('/admin/tickets/:id/cancel', requireAdmin, ticketController.cancelTicket);

// ── Coupons ──
router.get('/admin/coupons', requireAdmin, adminController.getAllCoupons);

// ── Service requests ──
// Customer support triage is a moderator's day job — restore full access.
router.get('/admin/service-requests', requireModeratorOrAdmin, serviceRequestController.getAllRequests);
router.patch('/admin/service-requests/:id/status', requireModeratorOrAdmin, serviceRequestController.updateStatus);
router.patch('/admin/service-requests/:id/resolve', requireModeratorOrAdmin, serviceRequestController.resolveRequest);
router.patch('/admin/service-requests/:id/in-progress', requireModeratorOrAdmin, serviceRequestController.markInProgress);

// ── Payouts ──
// Money. Moderator can see the queue (for investigation), admin approves.
router.get('/admin/payouts', requireModeratorOrAdmin, adminController.getAllPayouts);
router.patch('/admin/payouts/:id/approve', requireAdmin, adminController.approvePayout);
router.patch('/admin/payouts/:id/reject', requireAdmin, adminController.rejectPayout);
router.patch('/admin/payouts/:id/complete', auth, requireAdmin, adminController.completePayout);

// ── Logs ──
// Moderator reads logs (for investigation), admin can clear them.
router.get('/admin/logs', requireModeratorOrAdmin, logController.getLogs);
router.delete('/admin/logs', requireAdmin, logController.clearLogs);

// ── Settings ──
// Admin-only write. Moderators can still read so they see current fee rates
// when investigating disputes, but only an admin can change them.
// The settings service whitelist now covers: platformFee, platformFeeFloor,
// processingFee, processingFeeFloor, refundDeadlineDays.
router.get('/admin/settings', requireModeratorOrAdmin, settingsController.getSettings);
router.put('/admin/settings', requireAdmin, settingsController.updateSettings);

// ── Refunds ──
// Listing everything is admin-only. Completing an approved refund marks the
// money as actually paid out — admin-only.
router.get('/admin/refunds/all', requireAdmin, refundController.getAllRefunds);
router.patch('/admin/refunds/:id/complete', auth, requireAdmin, refundController.completeRefund);

// ── Featured ──
router.patch('/admin/events/:id/featured', auth, requireModeratorOrAdmin, featuredController.setFeatured);

module.exports = router;
