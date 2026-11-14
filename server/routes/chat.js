// routes/chat.js
const express = require('express');
const router = express.Router();

const chatController = require('../controllers/chatController');
const optionalAuth = require('../middleware/optionalAuth');
const { chatWriteLimiter, chatPollLimiter } = require('../middleware/rateLimit');

// ════════════════════════════════════════════════════
//  VISITOR ROUTES — guest-allowed (visitor or signed-in user)
// ════════════════════════════════════════════════════
//
// Owner / moderator routes live in routes/admin.js under /admin/chat/*
// (mounted with requireModeratorOrAdmin there). This file only handles
// the visitor widget.
//
// optionalAuth: signed-in visitors get req.user populated so their
// conversation is linked to their account; guests pass through as null.

router.post('/start',
  optionalAuth, chatWriteLimiter, chatController.start);

router.post('/:id/message',
  optionalAuth, chatWriteLimiter, chatController.visitorMessage);

// Visitor poll — kept LAST so the specific routes above match first.
router.get('/:id',
  optionalAuth, chatPollLimiter, chatController.visitorPoll);

module.exports = router;
