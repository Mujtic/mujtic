const mongoose = require('mongoose');

const refundSchema = new mongoose.Schema({
  ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true },
  // userId is nullable: guest tickets have no userId, and admins must be able
  // to cancel guest tickets via ticketService.cancelTicket. Service-level
  // ownership is enforced in refundService.requestRefund, not here.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },

  // What we're returning to the buyer. With the two-fee model this is
  // normally the full amountPaid (face price + buyer-paid processing fee).
  amount: { type: Number, required: true, min: 0 },

  reason: { type: String, required: true },
  // pending   → waiting for the organizer/admin to review (buyer requests only)
  // approved  → money is owed to the buyer, not paid out yet
  // rejected  → request declined
  // completed → paid out (set by refundService.completeRefund)
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'completed'],
    default: 'pending',
  },
  // Where the refund came from, so screens and reports can tell them apart.
  //   buyer_request   → the attendee asked for it
  //   admin_cancelled → an admin/organizer cancelled a single ticket
  //   event_cancelled → created automatically when the whole event was cancelled
  source: {
    type: String,
    enum: ['buyer_request', 'admin_cancelled', 'event_cancelled'],
    default: 'buyer_request',
  },
  requestedAt: { type: Date, default: Date.now },
  processedAt: { type: Date },
  processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rejectionReason: { type: String },
  // Set when the money has actually been returned to the buyer
  completedAt: { type: Date },
  paymentReference: { type: String, trim: true, maxlength: 100 },
  // For partial refunds (optional)
  isPartial: { type: Boolean, default: false },

  // Historical ticket values captured at the moment of the refund so
  // reports stay stable even if the Ticket document is edited later.
  //   originalPrice      → the face price the organizer priced
  //   originalAmountPaid → what the buyer actually paid (= price + processingFee)
  // Nullable for refunds created before the processing-fee split; those
  // records only have originalPrice, and downstream code should fall back
  // to it via `originalAmountPaid ?? originalPrice`.
  originalPrice:      { type: Number, default: null },
  originalAmountPaid: { type: Number, default: null },
});

// --- Indexes ---
// Cover the sort queries in refundService.js:
//   find({ userId }).sort('-requestedAt')                 → getUserRefunds
//   find({ eventId: { $in } }).sort('-requestedAt')       → getOrganizerRefunds
//   find().sort('-requestedAt')                           → getAllRefunds (admin)
// and the lookups added for event cancellation:
//   find({ ticketId: { $in }, status })                   → refundCancelledEvent
//   countDocuments({ eventId, status })                   → eventService.restoreEvent / deleteEvent
refundSchema.index({ userId: 1, requestedAt: -1 });
refundSchema.index({ eventId: 1, requestedAt: -1 });
refundSchema.index({ requestedAt: -1 });
refundSchema.index({ ticketId: 1, status: 1 });
refundSchema.index({ eventId: 1, status: 1 });

refundSchema.virtual('id').get(function() { return this._id.toString(); });
refundSchema.set('toJSON', { virtuals: true });
refundSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Refund', refundSchema);
