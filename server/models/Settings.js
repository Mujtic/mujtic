const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  // Percentage taken from each sale (kept under its original name: the website,
  // the admin panel, payouts and analytics all read `platformFee`).
  platformFee: { type: Number, default: 3, min: 0, max: 50 },
  // Minimum fee per order, in Ghana cedis. 0 = no minimum, so existing
  // behaviour does not change until an admin sets one.
  platformFeeFloor: { type: Number, default: 0, min: 0, max: 50 },
  // Platform default for who pays the fee. An event can override it
  // (Event.feePaidBy) while allowOrganizerFeeChoice is on.
  // 'organizer' = deducted from the organizer's sales,
  // 'buyer' = added on top of the ticket price at checkout.
  feePaidBy: { type: String, enum: ['organizer', 'buyer'], default: 'organizer' },
  // true  = organizers may choose who pays the fee for each event
  // false = every new event uses the platform default above (the field is
  //         hidden from organizers and ignored if sent)
  allowOrganizerFeeChoice: { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now },
  refundDeadlineDays: { type: Number, default: 7 },
});

settingsSchema.virtual('id').get(function() { return this._id.toString(); });
settingsSchema.set('toJSON', { virtuals: true });
settingsSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Settings', settingsSchema);
