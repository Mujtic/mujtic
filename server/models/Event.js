const mongoose = require('mongoose');

const ticketTypeSchema = new mongoose.Schema({
  price: { type: Number, required: true, min: 0 },
  capacity: { type: Number, required: true, min: 1 },
  sold: { type: Number, default: 0 },
  earlyBirdPrice: { type: Number },
  earlyBirdEnd: { type: Date },
  groupDiscount: { type: Number, default: 0 },
  groupDiscountMinQty: { type: Number, default: 5, min: 1 },
});

const eventSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  date: { type: Date, required: true },
  venue: { type: String, required: true },
  location: { type: String },
  category: { type: String, required: true },
  currency: {
    type: String,
    required: true,
    enum: ['USD', 'EUR', 'GBP', 'CAD', 'GHC'],
  },
  image: { type: String },
  ticketTypes: { type: Map, of: ticketTypeSchema, required: true },
  organizerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  organizerEmail: { type: String, required: true },
  organizerPhone: { type: String, required: true, match: /^\+233\d{9}$/ },
  isPublished: { type: Boolean, default: true },
  isCancelled: { type: Boolean, default: false },
  flagged: { type: Boolean, default: false },
  isFeatured:    { type: Boolean, default: false, index: true },
  featuredOrder: { type: Number, default: 0 },

  // Fee payer is no longer per-event: the platform fee is always paid by the
  // organizer (deducted from payout) and the processing fee is always paid
  // by the buyer (added at checkout). Both rates come from Settings at the
  // moment of purchase and are frozen onto each Ticket, so changing settings
  // later cannot reprice past sales. See models/Ticket.js.

  // Scheduling — stored for future use. Actual scheduled publishing requires
  // a background job that flips isPublished when this timestamp arrives.
  // As of now, createEvent still publishes immediately (isPublished: true),
  // so this field is persisted but not yet enforced by anything.
  publishAt: { type: Date, default: null },

  // Maps location — used by showEventDetail to render "View on map" link
  lat: { type: Number, default: null },
  lng: { type: Number, default: null },
  address: { type: String, default: null },

  createdAt: { type: Date, default: Date.now },
});

// --- Indexes ---
// Cover the queries in eventService.getEvents and app.js renderEvents:
//   find({ isPublished, isCancelled, date: { $gt } })    → home upcoming list
//   find({ organizerId })                                 → my-events, payouts, refunds
//   find({ organizerId, isCancelled: false })             → payoutService balance calc
//   find({ flagged: true })                               → admin flagged filter
//   find({ category, date: { $gt } })                     → category filter
//   find({ location, date: { $gt } })                     → location filter
eventSchema.index({ isPublished: 1, isCancelled: 1, date: 1 });
eventSchema.index({ organizerId: 1, createdAt: -1 });
eventSchema.index({ organizerId: 1, isCancelled: 1 });
eventSchema.index({ flagged: 1 });
eventSchema.index({ category: 1, date: 1 });
eventSchema.index({ location: 1, date: 1 });

eventSchema.virtual('id').get(function() { return this._id.toString(); });
eventSchema.set('toJSON', { virtuals: true });
eventSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Event', eventSchema);
