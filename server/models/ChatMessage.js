const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema({
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
  from:           { type: String, enum: ['visitor', 'owner'], required: true },
  senderName:     { type: String, default: '' },
  text:           { type: String, required: true, trim: true, maxlength: 2000 },
}, { timestamps: true });

chatMessageSchema.index({ conversationId: 1, createdAt: 1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
