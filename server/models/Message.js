const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },        // e.g. msg_1735123456789 or bcast_...
  type: { type: String, enum: ['direct', 'broadcast'], required: true },
  audience: {
    type: String,
    // Nullable: some messages may not have audience semantics (e.g. direct
    // messages that predate the explicit 'individual' label). Enum values
    // must match every path in messageService.js — including 'individual'
    // for createDirectMessage. Mongoose skips enum validation for null/
    // undefined values, so pre-existing null rows remain valid.
    enum: ['all_users', 'organizers', 'customers', 'both', 'individual', 'newsletter'],
  },
  subject: { type: String, required: true, maxlength: 200 },
  body: { type: String, required: true, maxlength: 10000 },
  channel: { type: String, enum: ['email', 'sms', 'both'], required: true },
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },  // for direct messages
  recipientName: { type: String },
  recipientEmail: { type: String, lowercase: true, trim: true },
  recipientCount: { type: Number, default: 1 },
  sentBy: { type: String, required: true },   // admin name
  sentAt: { type: Date, default: Date.now },
});

// ── Indexes ──
// Cover the queries in messageService.getAllMessages:
//   find().sort({ sentAt: -1 })                          → admin message list
//   find({ type }).sort({ sentAt: -1 })                   → type filter
//   find({ audience }).sort({ sentAt: -1 })               → audience filter
messageSchema.index({ sentAt: -1 });
messageSchema.index({ type: 1, sentAt: -1 });
messageSchema.index({ audience: 1, sentAt: -1 });

messageSchema.set('toJSON',   { virtuals: true });
messageSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Message', messageSchema);
