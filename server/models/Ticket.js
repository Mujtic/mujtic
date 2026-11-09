// models/Ticket.js
const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },   // public ticket code (UUID)
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },  // null for guest purchases
  ticketType: { type: String, required: true },

  // ── Money, recorded once when the ticket is bought ──
  // Never recomputed from today's settings, so changing the fee rule can't
  // reprice past sales. revenueService / analyticsService / payoutService read these.
  //
  // Two independent fee tracks since the split:
  //   platformFee   → ORGANIZER-paid, deducted from their payout
  //   processingFee → BUYER-paid, added on top of the face price
  //
  // Legacy tickets (bought before the split) have processingFee === null and a
  // single fee stored in platformFee whose payer is recorded in feePaidBy.
  // Downstream code should use `processingFee == null` as the sentinel.
  price:         { type: Number, required: true },                 // face price: what the organizer is paid for (after discounts)
  platformFee:   { type: Number, default: null, min: 0 },          // ORGANIZER-paid fee (null = bought before fees were stored)
  processingFee: { type: Number, default: null, min: 0 },          // BUYER-paid fee (null = legacy ticket, use feePaidBy)
  feePaidBy:     { type: String, enum: ['organizer', 'buyer'], default: null },  // LEGACY — only meaningful when processingFee == null
  amountPaid:    { type: Number, default: null, min: 0 },          // what the buyer actually paid: price + processingFee

  purchasedAt: { type: Date, default: Date.now },

  // Attendee contact
  userEmail: { type: String, required: true, lowercase: true, trim: true },
  userPhone: { type: String, default: null, match: /^\+233\d{9}$/ },
  buyerName: { type: String, default: null },

  // Payment / refund traceability
  paymentIntentId: { type: String, default: null },      // Stripe / Paystack reference
  paymentGateway:  { type: String, enum: ['stripe', 'paystack', 'paypal', 'manual'], default: null },

  // Purchase details
  promoCode: { type: String, default: null },
  discountAmount: { type: Number, default: 0 },
  companyName: { type: String },
  billingAddress: { type: String },
  poNumber: { type: String },

  // Lifecycle flags
  validated: { type: Boolean, default: false },
  validatedAt: { type: Date, default: null },
  validatedBy: { type: String, default: null },

  refunded: { type: Boolean, default: false },
  refundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Refund', default: null },
  refundedAt: { type: Date, default: null },

  reviewed: { type: Boolean, default: false },

  status: {
    type: String,
    enum: ['active', 'used', 'cancelled', 'refunded', 'refund_pending'],
    default: 'active',
  },
}, { timestamps: true });

// --- Indexes (query performance) ---
ticketSchema.index({ eventId: 1, status: 1 });
ticketSchema.index({ eventId: 1, purchasedAt: 1 });
ticketSchema.index({ userId: 1, purchasedAt: -1 });
ticketSchema.index({ status: 1 });
ticketSchema.index({ paymentIntentId: 1 }, { sparse: true });

module.exports = mongoose.model('Ticket', ticketSchema);
