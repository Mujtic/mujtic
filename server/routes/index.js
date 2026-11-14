const express = require('express');

// ── Sub-routers ──
// Each mounts at the root ('/api') and defines its own path prefix
// (e.g. authRoutes handles '/auth/*', adminRoutes handles '/admin/*').
// Express matches in the order they're `.use()`d below — first match wins.
const authRoutes           = require('./auth');
const userRoutes           = require('./users');
const serviceRequestRoutes = require('./serviceRequests');
const newsletterRoutes = require('./newsletter');
const featuredRoutes = require('./featured');
const eventRoutes          = require('./events');
const ticketRoutes         = require('./tickets');
const waitlistRoutes       = require('./waitlists');
const payoutRoutes         = require('./payouts');
const adminRoutes          = require('./admin');
const userSettingsRoutes   = require('./settings');
// const notificationRoutes = require('./notifications');  // see note below
const analyticsRoutes      = require('./analytics');
const refundRoutes         = require('./refunds');
const reviewRoutes         = require('./reviews');
const messageRoutes        = require('./messages');
const couponRoutes         = require('./coupons');
const staffRoutes          = require('./staff');
const cronRoutes           = require('./cron');
const chatRoutes           = require('./chat');

const router = express.Router();

// ── Mount order rationale ──
//
// All sub-routers define disjoint path prefixes (auth/*, admin/*, staff/*,
// etc.), so order is theoretically arbitrary. It becomes meaningful only if
// two sub-routers accidentally define the same method+path — the first one
// mounted wins, the second is dead code with no warning.
//
// To verify no shadowing exists, run at boot (dev only):
//   const listEndpoints = require('express-list-endpoints');
//   console.table(listEndpoints(app));
// Duplicate method+path pairs in the output indicate a collision.
//
// The current order groups related domains: auth/staff first (login paths),
// public resources next (events/tickets/waitlists), then user-scoped
// (payouts/settings), then admin (last, since it's the most-specific prefix).

// ── Auth + staff ──
// Login surfaces. /staff/pin-login should be mounted with authLimiter inside
// staff.js — verify the route file includes it, otherwise PIN brute-force is
// unbounded.
router.use(authRoutes);
router.use(staffRoutes);

// ── Public-facing reads ──
// Event browsing, ticket purchase (guest + auth), waitlist join (guest + auth).
// These are the endpoints a logged-out visitor hits.
router.use(featuredRoutes);
router.use(eventRoutes);
router.use(ticketRoutes);
router.use(waitlistRoutes);
router.use(serviceRequestRoutes);
router.use(newsletterRoutes);

// Chat must be mounted with an explicit '/chat' prefix. chat.js defines
// bare paths ('/start', '/:id', '/conversations'). Without the prefix,
// router.get('/:id') would become GET /api/:id and intercept every
// single-segment GET route mounted below (payouts, settings, refunds,
// coupons, messages) — returning "visitorId is required" instead of
// reaching the real handler.
router.use('/chat', chatRoutes);

// ── Authenticated user scope ──
// Data scoped to req.user.id — payouts (organizer), settings (self), refunds
// (self + organizer), analytics (organizer), coupons (organizer), service
// requests (submit + admin list), messages (admin-only).
router.use(payoutRoutes);
router.use(userSettingsRoutes);
router.use(refundRoutes);
router.use(reviewRoutes);
router.use(analyticsRoutes);
router.use(couponRoutes);
router.use(messageRoutes);

// ── User CRUD (admin) ──
// All endpoints in users.js should be requireAdmin-gated.
router.use(userRoutes);

// ── Admin (mounted last) ──
// Every endpoint here needs requireAdmin. If any admin route is
// accidentally reachable without requireAdmin, this is the highest-value
// target — admin can manage users, delete events, approve payouts, wipe logs.
router.use(adminRoutes);
// ── Cron / scheduled jobs ──
// Gated by requireCronSecretOrAdmin — only the correct X-Cron-Secret header
// or an authenticated admin can trigger these. Keeping them adjacent to
// adminRoutes makes it obvious which mounts are "privileged" so a future
// mount-order refactor doesn't accidentally expose them behind a weaker route.
router.use(cronRoutes);

// ── Notifications ──
// Currently disabled. The notificationController was flagged during the
// controller review as a spam/phishing/toll-fraud gateway: it lets any
// authenticated caller send arbitrary emails/SMS through Resend/Twilio.
// Nothing in the codebase calls it. Re-enable ONLY after either:
//   (a) deleting notificationController.js + routes/notifications.js entirely, OR
//   (b) adding requireAdmin to every route in notifications.js AND
//       rate-limiting to prevent budget exhaustion.
//
// router.use(notificationRoutes);

module.exports = router;
