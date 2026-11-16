// models/Payment.js
const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true, index: true },

  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User',  default: null, index: true },

  ticketType: { type: String, required: true },
  quantity:   { type: Number, required: true, min: 1 },

  // What the buyer pays — snapshotted at init time so a mid-flight price
  // change (early-bird ending, coupon expiring) never invalidates a paid
  // transaction. Fulfillment uses these frozen numbers, not the live ones.
  amountGHS:     { type: Number, required: true },   // 155.50
  amountPesewas: { type: Number, required: true },   // 15550 (what we send Paystack)

  status: {
    type: String,
    enum: ['pending', 'success', 'failed', 'abandoned', 'refunded'],
    default: 'pending',
    index: true,
  },

  buyerEmail: { type: String, required: true, lowercase: true, trim: true },
  buyerPhone: { type: String, default: null },
  buyerName:  { type: String, default: null },

  promoCode:    { type: String, default: null },
  groupBooking: { type: mongoose.Schema.Types.Mixed, default: null },

  // Frozen pricing breakdown — same fields ticketService writes on tickets
  pricing: {
    faceTotal:       Number,   // amount the organizer is paid, before fees
    facePerTicket:   Number,
    discount:        Number,
    appliedCouponId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', default: null },
    platformFee:     Number,   // organizer-paid
    processingFee:   Number,   // buyer-paid
    buyerTotal:      Number,   // faceTotal - discount + processingFee
    currency:        String,
  },

  // Everything Paystack told us
  paystack: {
    authorizationUrl: String,
    accessCode:       String,
    channel:          String,
    gatewayResponse:  String,
    paidAt:           Date,
    ipAddress:        String,
  },

  // Populated on successful fulfillment
  ticketIds:    { type: [String], default: [] },  // Ticket.id (uuid)
  fulfilledAt:  { type: Date, default: null },
  failedReason: { type: String, default: null },

  createdAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

paymentSchema.index({ eventId: 1, status: 1 });
paymentSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Payment', paymentSchema);
