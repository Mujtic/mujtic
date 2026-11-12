const mongoose = require('mongoose');

const newsletterSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  },
  status: {
    type: String,
    enum: ['subscribed', 'unsubscribed'],
    default: 'subscribed',
  },
  source: {
    type: String,
    enum: ['footer', 'checkout', 'registration', 'admin', 'other'],
    default: 'footer',
  },
  // Used in every newsletter email to allow one-click unsubscribe.
  // Rotates on every reactivation so a stale link can't be reused.
  unsubscribeToken: { type: String, required: true, unique: true },
  ip: { type: String, default: null },
  userAgent: { type: String, default: null },
  consentGiven: { type: Boolean, default: true },
  subscribedAt: { type: Date, default: Date.now },
  unsubscribedAt: { type: Date, default: null },
}, { timestamps: true });

// Query patterns:
//   findOne({ email })                    → subscribe (idempotency check)
//   findOne({ unsubscribeToken })         → unsubscribe link
//   find({ status }).sort({ subscribedAt }) → admin list
newsletterSchema.index({ status: 1, subscribedAt: -1 });

newsletterSchema.virtual('id').get(function() { return this._id.toString(); });
newsletterSchema.set('toJSON', { virtuals: true });
newsletterSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Newsletter', newsletterSchema);
