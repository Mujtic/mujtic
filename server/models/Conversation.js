const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema({
  visitorId:      { type: String, required: true, index: true },   // random token in visitor's localStorage
  visitorName:    { type: String, default: '' },
  visitorEmail:   { type: String, default: '' },
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },  // set if signed in
  status:         { type: String, enum: ['open', 'closed'], default: 'open', index: true },
  lastMessageAt:  { type: Date, default: Date.now, index: true },
  lastMessageText: String,
  lastMessageFrom: { type: String, enum: ['visitor', 'owner'], default: 'visitor' },
  unreadForOwner:   { type: Number, default: 0 },
  unreadForVisitor: { type: Number, default: 0 },
}, { timestamps: true });

conversationSchema.index({ visitorId: 1, status: 1 });

module.exports = mongoose.model('Conversation', conversationSchema);
