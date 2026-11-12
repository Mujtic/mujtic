// services/messageService.js
const crypto = require('crypto');
const Message = require('../models/Message');
const User = require('../models/User');
const Newsletter = require('../models/Newsletter');
const { sendEmail, sendSMS } = require('./notificationService');
const { AppError } = require('../utils/appError');
const { logger } = require('../config/logger');
const { escapeHtml, sanitizeHeader } = require('../utils/htmlSecurity');

const VALID_CHANNELS = ['email', 'sms', 'both'];
const VALID_AUDIENCES = ['all_users', 'organizers', 'customers', 'both', 'newsletter'];

const assertChannel = (channel) => {
  if (!VALID_CHANNELS.includes(channel)) {
    throw new AppError(`Channel must be one of: ${VALID_CHANNELS.join(', ')}`, 400);
  }
};

const assertNonEmpty = (value, field) => {
  if (!value || typeof value !== 'string' || !value.trim()) {
    throw new AppError(`${field} is required`, 400);
  }
};

// Collision-resistant id (was: 'msg_' + Date.now(), could collide on bursts)
const genId = (prefix) =>
  `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

class MessageService {
  async createDirectMessage(recipientId, subject, body, channel, sentBy) {
    // --- Validation ---
    if (!recipientId) throw new AppError('recipientId is required', 400);
    assertNonEmpty(subject, 'Subject');
    assertNonEmpty(body, 'Body');
    assertChannel(channel);

    const recipient = await User.findById(recipientId).select('name email phone').lean();
    if (!recipient) throw new AppError('Recipient not found', 404);

    if ((channel === 'email' || channel === 'both') && !recipient.email) {
      throw new AppError('Recipient has no email address on file', 400);
    }
    if ((channel === 'sms' || channel === 'both') && !recipient.phone) {
      throw new AppError('Recipient has no phone number on file', 400);
    }

    // --- Save the record first ---
    const message = new Message({
      id: genId('msg'),
      type: 'direct',
      audience: 'individual',
      subject: sanitizeHeader(subject),
      body,
      channel,
      recipientId: recipient._id,
      recipientName: recipient.name,
      recipientEmail: recipient.email,
      recipientCount: 1,
      sentBy,
    });
    await message.save();

    // --- Deliver (best-effort — DB record already exists, don't fail the request) ---
    const htmlBody = `<pre>${escapeHtml(body)}</pre>`;
    const subjectSafe = sanitizeHeader(subject);

    if (channel === 'email' || channel === 'both') {
      sendEmail(recipient.email, subjectSafe, htmlBody, body)
        .catch((e) => logger.error('direct message email failed', {
          messageId: message.id, recipientId: recipient._id.toString(), err: e.message,
        }));
    }
    if (channel === 'sms' || channel === 'both') {
      sendSMS(recipient.phone, body)
        .catch((e) => logger.error('direct message SMS failed', {
          messageId: message.id, recipientId: recipient._id.toString(), err: e.message,
        }));
    }

    return message;
  }

  async createBroadcast(audience, subject, body, channel, sentBy) {
    // --- Validation ---
    if (!VALID_AUDIENCES.includes(audience)) {
      throw new AppError(`Audience must be one of: ${VALID_AUDIENCES.join(', ')}`, 400);
    }
    assertNonEmpty(subject, 'Subject');
    assertNonEmpty(body, 'Body');
    assertChannel(channel);

    // Newsletter subscribers opted into marketing emails only — they are
    // contacts, not registered users. SMS is not an option for this list.
    if (audience === 'newsletter' && channel !== 'email') {
      throw new AppError('Newsletter subscribers receive email only — choose "email" as the channel', 400);
    }

    if (audience === 'newsletter') {
      return this._broadcastToNewsletter(subject, body, sentBy);
    }

    // --- Build recipient query from validated audience only ---
    let query = {};
    if (audience === 'organizers') query = { role: 'organizer' };
    else if (audience === 'customers') query = { role: 'customer' };
    else if (audience === 'both') query = { role: { $in: ['customer', 'organizer'] } };
    // audience === 'all_users' → no filter (query stays {})

    const recipients = await User.find(query).select('email phone name').lean();
    const count = recipients.length;

    if (count === 0) {
      throw new AppError('No recipients match the selected audience', 400);
    }

    // --- Save the record ---
    const message = new Message({
      id: genId('bcast'),
      type: 'broadcast',
      audience,
      subject: sanitizeHeader(subject),
      body,
      channel,
      recipientCount: count,
      sentBy,
    });
    await message.save();

    // --- Deliver (fire-and-forget with per-recipient error logging) ---
    const htmlBody = `<pre>${escapeHtml(body)}</pre>`;
    const subjectSafe = sanitizeHeader(subject);

    let delivered = 0;
    for (const user of recipients) {
      if (channel === 'email' || channel === 'both') {
        if (user.email) {
          delivered++;
          sendEmail(user.email, subjectSafe, htmlBody, body)
            .catch((e) => logger.error('broadcast email failed', {
              messageId: message.id, recipientId: user._id.toString(), err: e.message,
            }));
        }
      }
      if (channel === 'sms' || channel === 'both') {
        if (user.phone) {
          delivered++;
          sendSMS(user.phone, body)
            .catch((e) => logger.error('broadcast SMS failed', {
              messageId: message.id, recipientId: user._id.toString(), err: e.message,
            }));
        }
      }
    }

    logger.info('Broadcast dispatched', {
      messageId: message.id, audience, channel,
      recipients: count, deliveryAttempts: delivered,
    });

    return message;
  }

  // ── Newsletter broadcast ──
  // Marketing sends require per-recipient unsubscribe links, which means we
  // can't share one HTML body across the list. Each email gets its own footer
  // with the recipient's personal token — compliance for CAN-SPAM / GDPR /
  // Ghana's Data Protection Act.
  async _broadcastToNewsletter(subject, body, sentBy) {
    const subs = await Newsletter.find({ status: 'subscribed' })
      .select('email unsubscribeToken')
      .lean();
    const count = subs.length;

    if (count === 0) {
      throw new AppError('No newsletter subscribers are currently subscribed', 400);
    }

    const message = new Message({
      id: genId('bcast'),
      type: 'broadcast',
      audience: 'newsletter',
      subject: sanitizeHeader(subject),
      body,
      channel: 'email',
      recipientCount: count,
      sentBy,
    });
    await message.save();

    const subjectSafe = sanitizeHeader(subject);
    const frontendUrl = (process.env.FRONTEND_URL || 'https://glycr.com').replace(/\/$/, '');

    let delivered = 0;
    for (const sub of subs) {
      const unsubscribeUrl = `${frontendUrl}/api/newsletter/unsubscribe/${sub.unsubscribeToken}`;

      const personalizedText = `${body}\n\n---\nYou received this because you subscribed to Glycr updates.\nUnsubscribe: ${unsubscribeUrl}`;

      const personalizedHtml = `
        <pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(body)}</pre>
        <div style="margin-top:2rem;padding-top:1rem;border-top:1px solid #eef2f7;font-size:0.75rem;color:#6b7f93;text-align:center;line-height:1.6;">
          You received this because you subscribed to Glycr updates.<br>
          <a href="${unsubscribeUrl}" style="color:#0d9488;text-decoration:underline;">Unsubscribe</a>
        </div>`;

      delivered++;
      sendEmail(sub.email, subjectSafe, personalizedHtml, personalizedText)
        .catch((e) => logger.error('newsletter broadcast email failed', {
          messageId: message.id,
          subscriberEmail: sub.email,
          err: e.message,
        }));
    }

    logger.info('Newsletter broadcast dispatched', {
      messageId: message.id,
      recipients: count,
      deliveryAttempts: delivered,
    });

    return message;
  }

  async getAllMessages(filters = {}) {
    const query = {};
    if (filters.type) query.type = filters.type;
    if (filters.audience) query.audience = filters.audience;

    let q = Message.find(query).sort({ sentAt: -1 });

    // Cap output — original returned every message ever sent
    const limit = Math.min(Number(filters.limit) || 100, 500);
    if (limit > 0) q = q.limit(limit);
    if (filters.skip) q = q.skip(Number(filters.skip) || 0);

    const messages = await q.lean();
    return { messages };
  }

  async deleteMessage(messageId) {
    if (!messageId || typeof messageId !== 'string') {
      throw new AppError('Message id is required', 400);
    }
    const msg = await Message.findOne({ id: messageId });
    if (!msg) throw new AppError('Message not found', 404);
    await msg.deleteOne();
    return true;
  }
}

module.exports = new MessageService();
