const express = require('express');
const router = express.Router();

const adminController = require('../controllers/adminController');
const settingsController = require('../controllers/settingsController');
const ticketController = require('../controllers/ticketController');
const logController = require('../controllers/logController');
const refundController = require('../controllers/refundController');
const serviceRequestController = require('../controllers/serviceRequestController');
const featuredController = require('../controllers/featuredController');
const newsletterController = require('../controllers/newsletterController');
const chatController = require('../controllers/chatController');

const auth = require('../middleware/auth');
const { requireAdmin, requireModeratorOrAdmin } = require('../middleware/rbac');
const { validate, convertWaitlistSchema } = require('../middleware/validation');
const { chatWriteLimiter, chatPollLimiter } = require('../middleware/rateLimit');

// Every /admin/* route is authenticated here. Role gates per-route below.
router.use('/admin', auth);

// ── Dashboard ──
router.get('/admin/stats', auth, requireModeratorOrAdmin, adminController.getStats);

// ── Users ──
router.get('/admin/users', auth, requireModeratorOrAdmin, adminController.getAllUsers);
router.patch('/admin/users/:id/suspend', auth, requireModeratorOrAdmin, adminController.suspendUser);
router.post('/admin/users', auth, requireAdmin, adminController.createUser);
router.put('/admin/users/:id', auth, requireAdmin, adminController.updateUser);
router.patch('/admin/users/:id/role', auth, requireAdmin, adminController.changeUserRole);
router.delete('/admin/users/:id', auth, requireAdmin, adminController.deleteUser);

// ── Waitlist ──
router.get('/admin/waitlists',auth, requireModeratorOrAdmin, adminController.getAllWaitlists);
router.post('/admin/waitlist/:id/notify', auth, requireModeratorOrAdmin, adminController.notifyWaitlistEntry);
router.post(
  '/admin/waitlist/:id/convert', auth,
  requireAdmin,
  validate(convertWaitlistSchema),
  adminController.convertWaitlistToTicket
);
router.delete('/admin/waitlist/:id', auth, requireAdmin, adminController.deleteWaitlistEntry);

// ── Events ──
router.get('/admin/events', auth, requireModeratorOrAdmin, adminController.getAllEvents);
router.patch('/admin/events/:id/flag', auth, requireModeratorOrAdmin, adminController.flagEvent);
router.patch('/admin/events/:id/unflag', auth, requireModeratorOrAdmin, adminController.unflagEvent);
router.patch('/admin/events/:id/publish', auth, requireModeratorOrAdmin, adminController.togglePublish);
router.delete('/admin/events/:id', auth, requireAdmin, adminController.deleteEvent);
router.patch('/admin/events/:id/cancel', auth, requireModeratorOrAdmin, adminController.cancelEvent);
router.patch('/admin/events/:id/restore', auth, requireModeratorOrAdmin, adminController.restoreEvent);

// ── Tickets ──
router.get('/admin/tickets', auth, requireModeratorOrAdmin, adminController.getAllTickets);
router.patch('/admin/tickets/:id/validate', auth, requireAdmin, ticketController.validateTicket);
router.patch('/admin/tickets/:id/cancel', auth, requireAdmin, ticketController.cancelTicket);

// ── Coupons ──
router.get('/admin/coupons', auth, requireAdmin, adminController.getAllCoupons);

// ── Service requests ──
router.get('/admin/service-requests',  auth, requireModeratorOrAdmin, serviceRequestController.getAllRequests);
router.patch('/admin/service-requests/:id/status', auth, requireModeratorOrAdmin, serviceRequestController.updateStatus);
router.patch('/admin/service-requests/:id/resolve', auth, requireModeratorOrAdmin, serviceRequestController.resolveRequest);
router.patch('/admin/service-requests/:id/in-progress',auth,  requireModeratorOrAdmin, serviceRequestController.markInProgress);

// ── Payouts ──
router.get('/admin/payouts', auth, requireModeratorOrAdmin, adminController.getAllPayouts);
router.patch('/admin/payouts/:id/approve', auth, requireAdmin, adminController.approvePayout);
router.patch('/admin/payouts/:id/reject', auth,  requireAdmin, adminController.rejectPayout);
router.patch('/admin/payouts/:id/complete', auth, requireAdmin, adminController.completePayout);

// ── Logs ──
router.get('/admin/logs', auth, requireModeratorOrAdmin, logController.getLogs);
router.delete('/admin/logs', auth, requireAdmin, logController.clearLogs);

// ── Settings ──
router.get('/admin/settings', auth, requireModeratorOrAdmin, settingsController.getSettings);
router.put('/admin/settings', auth, requireAdmin, settingsController.updateSettings);

// ── Refunds ──
router.get('/admin/refunds/all', auth, requireAdmin, refundController.getAllRefunds);
router.patch('/admin/refunds/:id/complete', auth, requireAdmin, refundController.completeRefund);

// ── Featured ──
router.patch('/admin/events/:id/featured', auth, requireModeratorOrAdmin, featuredController.setFeatured);

// ── Newsletter subscribers ──
router.get('/admin/newsletter', auth, requireAdmin, newsletterController.listSubscribers);
router.get('/admin/newsletter/stats', auth, requireAdmin, newsletterController.getStats);
router.delete('/admin/newsletter/:id', auth, requireAdmin, newsletterController.deleteSubscriber);

// ════════════════════════════════════════════════════
//  SUPPORT CHAT (inbox)
//  Platform support inbox — admins + moderators. Organizers are event
//  creators, not support staff; staff tokens are event-scoped scanners.
//  Both are excluded by requireModeratorOrAdmin.
// ════════════════════════════════════════════════════

router.get('/admin/chat/unread-count',
  auth, requireModeratorOrAdmin, chatController.unreadCount);

router.get('/admin/chat/conversations',
  auth, requireModeratorOrAdmin, chatController.listConversations);

router.get('/admin/chat/conversations/:id',
  auth, requireModeratorOrAdmin, chatPollLimiter, chatController.getConversation);

router.post('/admin/chat/conversations/:id/reply',
  auth, requireModeratorOrAdmin, chatWriteLimiter, chatController.ownerReply);

router.post('/admin/chat/conversations/:id/close',
  auth, requireModeratorOrAdmin, chatController.close);

// Bulk delete — admin-only. MUST come before the single-delete `:id` route
// below, otherwise Express matches "bulk-delete" as the `:id` param.
router.post('/admin/chat/conversations/bulk-delete',
  auth, requireAdmin, chatController.bulkDeleteConversations);

// Single delete — admin-only.
router.delete('/admin/chat/conversations/:id',
  auth, requireAdmin, chatController.deleteConversation);

module.exports = router;
