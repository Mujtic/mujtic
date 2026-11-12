const mongoose = require('mongoose');

const serviceRequestSchema = new mongoose.Schema({
  requestId: { type: String, unique: true, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  userName: { type: String, required: true },
  userEmail: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  },
  userPhone: {
    type: String,
    default: null,
    match: /^\+233\d{9}$/,
  },
  category: {
    type: String,
    enum: ['ticket_issue', 'payment_problem', 'refund_request', 'organizer_support', 'account_issue', 'bug_report', 'other'],
    default: 'other',
  },
  subject: { type: String, required: true, maxlength: 200 },
  message: { type: String, required: true, maxlength: 5000 },
  status: {
    type: String,
    // Must match VALID_STATUSES in serviceRequestService.js
    enum: ['pending', 'in_progress', 'resolved', 'closed', 'cancelled'],
    default: 'pending',
  },
  submittedAt: { type: Date, default: Date.now },
  resolvedAt: { type: Date, default: null },
  resolutionNotes: { type: String, default: null },
});

// --- Indexes ---
// Cover the queries in serviceRequestService.js:
//   find().sort({ submittedAt: -1 })                    → getAllRequests
//   countDocuments({ submittedAt: { $gte, $lte } })      → createRequest daily count
//   find({ status }).sort({ submittedAt: -1 })           → admin filter (future)
serviceRequestSchema.index({ submittedAt: -1 });
serviceRequestSchema.index({ status: 1, submittedAt: -1 });

serviceRequestSchema.virtual('id').get(function() { return this._id.toString(); });
serviceRequestSchema.set('toJSON', { virtuals: true });
serviceRequestSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('ServiceRequest', serviceRequestSchema);
