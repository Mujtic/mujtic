const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  // ── Platform fee — paid by the ORGANIZER ───────────────────────
  // Percentage taken from each sale and deducted from the organizer's
  // payout. Existing fee, kept under its original name so the website,
  // admin panel, payouts and analytics that already read `platformFee`
  // keep working unchanged. Never added to the buyer's total.
  platformFee: { type: Number, default: 3, min: 0, max: 50 },
  // Minimum platform fee per order, in Ghana cedis — ORGANIZER side.
  // Guarantees platform revenue per order even when the percentage
  // would be tiny (e.g. 3% of a 5 GHC ticket = 0.15 GHC).
  // 0 = no minimum. (The buyer-side floor is `processingFeeFloor`.)
  platformFeeFloor: { type: Number, default: 0, min: 0, max: 50 },

  // ── Processing fee — paid by the BUYER ─────────────────────────
  // Percentage added on top of the ticket price at checkout. Admin sets
  // this. Always paid by the buyer, never deducted from the organizer.
  // Default 0 so existing installs don't suddenly start charging.
  processingFee: { type: Number, default: 0, min: 0, max: 50 },
  // Minimum processing fee per order, in Ghana cedis — BUYER side.
  // 0 = no minimum.
  processingFeeFloor: { type: Number, default: 0, min: 0, max: 50 },

  updatedAt: { type: Date, default: Date.now },
  refundDeadlineDays: { type: Number, default: 7 },
});

settingsSchema.virtual('id').get(function() { return this._id.toString(); });
settingsSchema.set('toJSON', { virtuals: true });
settingsSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Settings', settingsSchema);
