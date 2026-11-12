const crypto = require('crypto');
const Newsletter = require('../models/Newsletter');
const { AppError } = require('../utils/appError');
const { logger } = require('../config/logger');

class NewsletterService {
  _generateToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  // Idempotent subscribe. Three cases:
  //   1. brand new email  → insert
  //   2. subscribed       → no-op (silent success, no error to user)
  //   3. unsubscribed     → reactivate (flips status, rotates token, clears timestamp)
  async subscribe(email, meta = {}) {
    const normalized = String(email || '').toLowerCase().trim();
    if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new AppError('A valid email address is required', 400);
    }

    const existing = await Newsletter.findOne({ email: normalized });

    if (existing) {
      if (existing.status === 'subscribed') {
        // Already subscribed — return success so the frontend doesn't error.
        // Deliberately do NOT reveal "already subscribed" to the client
        // (email enumeration protection). Frontend just shows "Subscribed!".
        return { subscribed: true };
      }
      // Reactivate: rotate token so any saved old unsubscribe link is invalidated
      existing.status = 'subscribed';
      existing.unsubscribedAt = null;
      existing.subscribedAt = new Date();
      existing.unsubscribeToken = this._generateToken();
      if (meta.ip) existing.ip = meta.ip;
      if (meta.userAgent) existing.userAgent = meta.userAgent;
      await existing.save();
      logger.info('Newsletter re-subscribed', { email: normalized });
      return { subscribed: true };
    }

    const doc = new Newsletter({
      email: normalized,
      status: 'subscribed',
      source: meta.source || 'footer',
      unsubscribeToken: this._generateToken(),
      ip: meta.ip || null,
      userAgent: meta.userAgent || null,
      consentGiven: true,
    });
    await doc.save();
    logger.info('Newsletter new subscriber', { email: normalized, source: doc.source });
    return { subscribed: true };
  }

  async unsubscribeByToken(token) {
    if (!token || typeof token !== 'string') {
      throw new AppError('Invalid unsubscribe link', 400);
    }
    const record = await Newsletter.findOne({ unsubscribeToken: token });
    if (!record) {
      throw new AppError('This unsubscribe link is invalid or has expired', 404);
    }
    if (record.status === 'unsubscribed') {
      return { alreadyUnsubscribed: true, email: record.email };
    }
    record.status = 'unsubscribed';
    record.unsubscribedAt = new Date();
    await record.save();
    logger.info('Newsletter unsubscribed', { email: record.email });
    return { alreadyUnsubscribed: false, email: record.email };
  }

  async listSubscribers(filters = {}) {
    const limit = Math.min(Number(filters.limit) || 200, 500);
    const skip  = Number(filters.skip) || 0;
    const query = {};
    if (filters.status && filters.status !== 'all') query.status = filters.status;
    if (filters.search && typeof filters.search === 'string') {
      const escaped = filters.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 100);
      query.email = { $regex: escaped, $options: 'i' };
    }
    return Newsletter.find(query).sort({ subscribedAt: -1 }).skip(skip).limit(limit).lean();
  }

  async deleteSubscriber(id) {
    const doc = await Newsletter.findByIdAndDelete(id);
    if (!doc) throw new AppError('Subscriber not found', 404);
    logger.info('Newsletter subscriber deleted', { email: doc.email });
    return { deleted: true };
  }

  async getStats() {
    const [total, subscribed, unsubscribed] = await Promise.all([
      Newsletter.countDocuments(),
      Newsletter.countDocuments({ status: 'subscribed' }),
      Newsletter.countDocuments({ status: 'unsubscribed' }),
    ]);
    return { total, subscribed, unsubscribed };
  }
}

module.exports = new NewsletterService();
