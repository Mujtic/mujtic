// services/chatService.js
const Conversation = require('../models/Conversation');
const ChatMessage  = require('../models/ChatMessage');
const { AppError } = require('../utils/appError');
const { logger }   = require('../config/logger');
const { isObjectIdString } = require('../utils/validators');
const Security = require('../utils/security');

const MAX_TEXT_LEN = 2000;
const SNIPPET_LEN  = 120;
const LIST_LIMIT   = 500;

class ChatService {

  // ── shared helpers ─────────────────────────────────────────────

  _requireText(text, field = 'text') {
    const raw = String(text || '').trim();
    if (!raw) throw new AppError(`${field} is required`, 400);
    if (raw.length > MAX_TEXT_LEN) throw new AppError(`${field} is too long (max ${MAX_TEXT_LEN})`, 400);

    const clean = Security.sanitizeChatText(raw, MAX_TEXT_LEN);
    if (!clean) throw new AppError(`${field} cannot be empty after sanitization`, 400);
    return clean;
  }

  async _findConvOrThrow(convId, filter = {}) {
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

  // Notify the support team when a conversation goes from 0 → 1 unread
  // messages. The email intentionally contains NO user content — just a
  // nudge and a link. This is the safest possible shape: there is nothing
  // in the email body that could be HTML-injected, so no escaping required
  // and no way for a malicious visitor to control what the admin inbox sees.
  //
  // Subsequent messages while `unreadForOwner >= 1` do not re-send — the
  // admin already has one pending notification for this thread.
  async _notifySupportOnce(conv) {
    if (conv.unreadForOwner !== 1) return;
    const to = process.env.SUPPORT_NOTIFY_EMAIL;
    if (!to) return;
    try {
      const { sendEmail } = require('./notificationService');
      const adminUrl = process.env.ADMIN_URL || 'https://glycr.onrender.com/admin';
      await sendEmail(
        to,
        'New Mujtic support message',
        `<p>You have a new message in the Mujtic Support Inbox.</p>
         <p><a href="${adminUrl}">Open the Support Inbox</a></p>
         <p style="color:#94a3b8;font-size:0.85em;">Conversation: ${String(conv._id)}</p>`
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
        visitorName:  name  ? Security.sanitizeInput(String(name),  { maxLength: 100 }) : '',
        visitorEmail: email ? Security.sanitizeInput(String(email), { maxLength: 200 }) : '',
        userId:       userId || null,
      });
    } else {
      let dirty = false;
      if (name  && name  !== conv.visitorName)  { conv.visitorName  = Security.sanitizeInput(String(name),  { maxLength: 100 });  dirty = true; }
      if (email && email !== conv.visitorEmail) { conv.visitorEmail = Security.sanitizeInput(String(email), { maxLength: 200 }); dirty = true; }
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

    // Fire-and-forget; already catches internally.
    this._notifySupportOnce(conv);

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

  async listConversations({ status = 'open', from = null, to = null } = {}) {
    const q = status === 'all' ? {} : { status };

    // Date range applies to `lastMessageAt` (activity), not `createdAt`.
    // A conversation is "in range" if it had any activity in the window —
    // that's what "recent support conversations" actually means.
    if (from || to) {
      q.lastMessageAt = {};
      if (from) q.lastMessageAt.$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);   // inclusive of the whole `to` day
        q.lastMessageAt.$lte = end;
      }
    }

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
      senderName: Security.sanitizeInput(String(ownerName || 'Support'), { maxLength: 100 }),
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

  async deleteConversationById({ convId }) {
    if (!isObjectIdString(String(convId))) {
      throw new AppError('Conversation not found', 404);
    }
    const conv = await Conversation.findById(convId);
    if (!conv) throw new AppError('Conversation not found', 404);

    const messageCount = await ChatMessage.countDocuments({ conversationId: conv._id });
    const snapshot = {
      _id: conv._id,
      visitorId: conv.visitorId,
      visitorName: conv.visitorName,
      visitorEmail: conv.visitorEmail,
      status: conv.status,
      messageCount,
    };

    await ChatMessage.deleteMany({ conversationId: conv._id });
    await conv.deleteOne();

    return snapshot;
  }

  async bulkDeleteConversations({ ids }) {
    if (!Array.isArray(ids) || !ids.length) {
      throw new AppError('ids must be a non-empty array', 400);
    }

    const validIds = ids.filter(id => isObjectIdString(String(id)));
    if (!validIds.length) {
      throw new AppError('No valid conversation ids provided', 400);
    }

    const convs = await Conversation.find({ _id: { $in: validIds } });
    if (!convs.length) {
      return { deleted: 0, snapshots: [], messageTotal: 0 };
    }

    const convObjectIds = convs.map(c => c._id);

    const counts = await ChatMessage.aggregate([
      { $match: { conversationId: { $in: convObjectIds } } },
      { $group: { _id: '$conversationId', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map(x => [String(x._id), x.count]));

    const snapshots = convs.map(c => ({
      _id: c._id,
      visitorName: c.visitorName,
      visitorEmail: c.visitorEmail,
      status: c.status,
      messageCount: countMap.get(String(c._id)) || 0,
    }));

    await ChatMessage.deleteMany({ conversationId: { $in: convObjectIds } });
    await Conversation.deleteMany({ _id: { $in: convObjectIds } });

    return {
      deleted: snapshots.length,
      snapshots,
      messageTotal: snapshots.reduce((s, x) => s + x.messageCount, 0),
    };
  }

  async countUnreadForOwner() {
    const rows = await Conversation.aggregate([
      { $match: { status: 'open' } },
      { $group: { _id: null, unread: { $sum: '$unreadForOwner' } } },
    ]);
    return rows[0]?.unread || 0;
  }
}

module.exports = new ChatService();
