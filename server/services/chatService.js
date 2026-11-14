// services/chatService.js
const Conversation = require('../models/Conversation');
const ChatMessage  = require('../models/ChatMessage');
const { AppError } = require('../utils/appError');
const { logger }   = require('../config/logger');
const { isObjectIdString } = require('../utils/validators');

const MAX_TEXT_LEN = 2000;
const SNIPPET_LEN  = 120;
const LIST_LIMIT   = 100;

class ChatService {

  // ── shared helpers ─────────────────────────────────────────────

  _requireText(text, field = 'text') {
    const t = String(text || '').trim();
    if (!t) throw new AppError(`${field} is required`, 400);
    if (t.length > MAX_TEXT_LEN) {
      throw new AppError(`${field} is too long (max ${MAX_TEXT_LEN})`, 400);
    }
    return t;
  }

  async _findConvOrThrow(convId, filter = {}) {
    // Guard BEFORE the query so a non-ObjectId string yields a clean 404,
    // not a Mongoose CastError surfaced as a 500 by errorHandler.
    if (!isObjectIdString(String(convId))) {
      throw new AppError('Conversation not found', 404);
    }
    const conv = await Conversation.findOne({ _id: convId, ...filter });
    if (!conv) throw new AppError('Conversation not found', 404);
    return conv;
  }

  async _requireVisitorConv(convId, visitorId) {
    if (!visitorId) throw new AppError('visitorId is required', 400);
    return this._findConvOrThrow(convId, { visitorId: String(visitorId) });
  }

  async _touch(conv, text, from) {
    conv.lastMessageAt   = new Date();
    conv.lastMessageText = text.slice(0, SNIPPET_LEN);
    conv.lastMessageFrom = from;
    await conv.save();
  }

  // Fire-and-forget email to the support team on the FIRST unread message
  // in a conversation. Later messages ride on the in-app badge instead of
  // spamming an inbox. Silent if SUPPORT_NOTIFY_EMAIL is unset.
  async _notifySupportOnce(conv, text) {
    if (conv.unreadForOwner !== 1) return;
    const to = process.env.SUPPORT_NOTIFY_EMAIL;
    if (!to) return;
    try {
      const { sendEmail } = require('./notificationService');
      const who = conv.visitorName || conv.visitorEmail || 'A visitor';
      await sendEmail(
        to,
        'New Mujtic support message',
        `<p><strong>${who}</strong> sent a message:</p>
         <p style="padding:0.75rem;background:#f4f7fa;border-radius:6px;">${String(text).slice(0, 500)}</p>
         <p>Open the Support Inbox in the dashboard to reply.</p>`
      );
    } catch (err) {
      logger.error('support notify email failed', { err: err.message, convId: String(conv._id) });
    }
  }

  // ── visitor side ───────────────────────────────────────────────

  async startConversation({ visitorId, name, email, userId = null } = {}) {
    if (!visitorId) throw new AppError('visitorId is required', 400);

    let conv = await Conversation.findOne({ visitorId, status: 'open' })
      .sort({ lastMessageAt: -1 });

    if (!conv) {
      conv = await Conversation.create({
        visitorId,
        visitorName:  name  || '',
        visitorEmail: email || '',
        userId:       userId || null,
      });
    } else {
      let dirty = false;
      if (name  && name  !== conv.visitorName)  { conv.visitorName  = name;  dirty = true; }
      if (email && email !== conv.visitorEmail) { conv.visitorEmail = email; dirty = true; }
      if (userId && String(userId) !== String(conv.userId)) { conv.userId = userId; dirty = true; }
      if (dirty) await conv.save();
    }
    return conv;
  }

  async visitorAddMessage({ convId, visitorId, text }) {
    const body = this._requireText(text);
    const conv = await this._requireVisitorConv(convId, visitorId);
    if (conv.status === 'closed') {
      throw new AppError('This conversation has ended', 400);
    }

    const msg = await ChatMessage.create({
      conversationId: conv._id,
      from: 'visitor',
      senderName: conv.visitorName || 'Visitor',
      text: body,
    });

    conv.unreadForOwner += 1;
    await this._touch(conv, body, 'visitor');

    // Non-blocking; already catches internally.
    this._notifySupportOnce(conv, body);

    return msg;
  }

  async visitorPollConversation({ convId, visitorId, since }) {
    const conv = await this._requireVisitorConv(convId, visitorId);

    const q = { conversationId: conv._id };
    if (since) q.createdAt = { $gt: new Date(since) };
    const messages = await ChatMessage.find(q).sort({ createdAt: 1 });

    // Any owner message in the batch ⇒ visitor has now seen them.
    if (messages.some(m => m.from === 'owner') && conv.unreadForVisitor > 0) {
      conv.unreadForVisitor = 0;
      await conv.save();
    }

    return {
      conversation: { _id: conv._id, status: conv.status },
      messages,
    };
  }

  // ── owner side (admin / moderator — the platform support team) ─

  async listConversations({ status = 'open' } = {}) {
    const q = status === 'all' ? {} : { status };
    return Conversation.find(q).sort({ lastMessageAt: -1 }).limit(LIST_LIMIT);
  }

  async getConversationForOwner({ convId, since }) {
    const conv = await this._findConvOrThrow(convId);

    const q = { conversationId: conv._id };
    if (since) q.createdAt = { $gt: new Date(since) };
    const messages = await ChatMessage.find(q).sort({ createdAt: 1 });

    if (conv.unreadForOwner > 0) {
      conv.unreadForOwner = 0;
      await conv.save();
    }

    return { conversation: conv, messages };
  }

  async ownerReplyToConversation({ convId, ownerName, text }) {
    const body = this._requireText(text);
    const conv = await this._findConvOrThrow(convId);
    if (conv.status === 'closed') {
      throw new AppError('Conversation closed', 400);
    }

    const msg = await ChatMessage.create({
      conversationId: conv._id,
      from: 'owner',
      senderName: ownerName || 'Support',
      text: body,
    });

    conv.unreadForVisitor += 1;
    await this._touch(conv, body, 'owner');

    return msg;
  }

  async closeConversationById({ convId }) {
    if (!isObjectIdString(String(convId))) {
      throw new AppError('Conversation not found', 404);
    }
    const conv = await Conversation.findByIdAndUpdate(
      convId,
      { status: 'closed' },
      { returnDocument: 'after' }
    );
    if (!conv) throw new AppError('Conversation not found', 404);
    return conv;
  }

  async countUnreadForOwner() {
    const rows = await Conversation.aggregate([
      { $match: { status: 'open' } },
      { $group: { _id: null, unread: { $sum: '$unreadForOwner' } } },
    ]);
    return rows[0]?.unread || 0;
  }

  async deleteConversationById({ convId }) {
    if (!isObjectIdString(String(convId))) {
      throw new AppError('Conversation not found', 404);
    }
    const conv = await Conversation.findById(convId);
    if (!conv) throw new AppError('Conversation not found', 404);

    // Snapshot metadata for the audit log before the docs are gone.
    const messageCount = await ChatMessage.countDocuments({ conversationId: conv._id });
    const snapshot = {
      _id: conv._id,
      visitorId: conv.visitorId,
      visitorName: conv.visitorName,
      visitorEmail: conv.visitorEmail,
      status: conv.status,
      messageCount,
    };

    // Delete messages first, then the conversation. If the second step fails
    // we end up with an empty conversation the admin can retry deleting —
    // far better than orphaning message documents.
    await ChatMessage.deleteMany({ conversationId: conv._id });
    await conv.deleteOne();

    return snapshot;
  }
}

module.exports = new ChatService();
