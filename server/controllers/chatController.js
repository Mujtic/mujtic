// controllers/chatController.js
const chatService = require('../services/chatService');
const logService  = require('../services/logService');

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

// ════════════════════════════════════════════════════
//  VISITOR (guest-allowed)
// ════════════════════════════════════════════════════

exports.start = async (req, res, next) => {
  try {
    const { visitorId, name, email } = req.body || {};
    const conversation = await chatService.startConversation({
      visitorId,
      name,
      email,
      userId: req.user?.id || null,   // optionalAuth populates this if signed in
    });
    res.json({ success: true, conversation });
  } catch (err) { next(err); }
};

exports.visitorMessage = async (req, res, next) => {
  try {
    const { visitorId, text } = req.body || {};
    const message = await chatService.visitorAddMessage({
      convId:    req.params.id,
      visitorId,
      text,
    });
    res.json({ success: true, message });
  } catch (err) { next(err); }
};

exports.visitorPoll = async (req, res, next) => {
  try {
    const result = await chatService.visitorPollConversation({
      convId:    req.params.id,
      visitorId: req.query.visitorId,
      since:     req.query.since,
    });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
};

// ════════════════════════════════════════════════════
//  OWNER (admin / moderator — platform support team)
// ════════════════════════════════════════════════════

exports.listConversations = async (req, res, next) => {
  try {
    const conversations = await chatService.listConversations({ status: req.query.status });
    res.json({ success: true, conversations });
  } catch (err) { next(err); }
};

exports.getConversation = async (req, res, next) => {
  try {
    const result = await chatService.getConversationForOwner({
      convId: req.params.id,
      since:  req.query.since,
    });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
};

exports.ownerReply = async (req, res, next) => {
  try {
    const message = await chatService.ownerReplyToConversation({
      convId:    req.params.id,
      ownerName: req.user.email,   // JWT payload has email, not name
      text:      req.body?.text,
    });

    logService.audit(req.user.email, 'support_reply', String(req.params.id), {
      type: 'event',
      adminId: req.user.id,
      conversationId: String(req.params.id),
      messageId: String(message._id),
      ...ctx(req),
    });

    res.json({ success: true, message });
  } catch (err) { next(err); }
};

exports.close = async (req, res, next) => {
  try {
    const conversation = await chatService.closeConversationById({ convId: req.params.id });

    logService.audit(req.user.email, 'support_close', String(req.params.id), {
      type: 'danger',
      adminId: req.user.id,
      conversationId: String(req.params.id),
      ...ctx(req),
    });

    res.json({ success: true, conversation });
  } catch (err) { next(err); }
};

exports.unreadCount = async (req, res, next) => {
  try {
    const count = await chatService.countUnreadForOwner();
    res.json({ success: true, count });
  } catch (err) { next(err); }
};

exports.deleteConversation = async (req, res, next) => {
  try {
    const snapshot = await chatService.deleteConversationById({ convId: req.params.id });

    logService.audit(req.user.email, 'support_delete', String(req.params.id), {
      type: 'danger',
      adminId: req.user.id,
      conversationId: String(req.params.id),
      visitorName: snapshot.visitorName,
      visitorEmail: snapshot.visitorEmail,
      messageCount: snapshot.messageCount,
      ...ctx(req),
    });

    res.json({ success: true, conversation: snapshot });
  } catch (err) { next(err); }
};
