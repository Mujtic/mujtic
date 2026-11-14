// routes/chat.js
const express = require('express');
const router = express.Router();

const chatController = require('../controllers/chatController');
const auth = require('../middleware/auth');
const optionalAuth = require('../middleware/optionalAuth');
const { requireModeratorOrAdmin } = require('../middleware/rbac');
const { chatWriteLimiter, chatPollLimiter } = require('../middleware/rateLimit');

// ════════════════════════════════════════════════════
//  OWNER ROUTES — platform support inbox
//  Admin + moderator only. Organizers are event creators,
//  not support staff; they have no business reading visitor
//  conversations. Staff tokens (scanners) are also excluded.
// ════════════════════════════════════════════════════
//
// Route order: /unread-count and /conversations must come
// BEFORE the visitor GET /:id at the bottom, otherwise Express
// matches them as :id and Conversation.findById('conversations')
// throws a CastError.

router.get('/unread-count',
  auth, requireModeratorOrAdmin, chatController.unreadCount);

router.get('/conversations',
  auth, requireModeratorOrAdmin, chatController.listConversations);

router.get('/conversations/:id',
  auth, requireModeratorOrAdmin, chatPollLimiter, chatController.getConversation);

router.post('/conversations/:id/reply',
  auth, requireModeratorOrAdmin, chatWriteLimiter, chatController.ownerReply);

router.post('/conversations/:id/close',
  auth, requireModeratorOrAdmin, chatController.close);

// ════════════════════════════════════════════════════
//  VISITOR ROUTES — guest-allowed (visitor or signed-in user)
// ════════════════════════════════════════════════════
//
// optionalAuth: a signed-in user gets req.user populated so the
// conversation links to their account (support sees a name, not
// "Anonymous"). Guests pass through as req.user = null.
// Staff tokens are downgraded to null by optionalAuth — fine, a
// scanner using the widget is just a visitor.

router.post('/start',
  optionalAuth, chatWriteLimiter, chatController.start);

router.post('/:id/message',
  optionalAuth, chatWriteLimiter, chatController.visitorMessage);

// Visitor poll — LAST so /conversations and /unread-count above
// are matched first. Called every 3s by the open widget.
router.get('/:id',
  optionalAuth, chatPollLimiter, chatController.visitorPoll);

module.exports = router;
