const mongoose = require('mongoose');

const scanLogSchema = new mongoose.Schema({
  ticketId:    { type: String, required: true },          // Ticket.id (not ObjectId)
  ticketRef:   { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true },
  eventId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Event',  required: true },
  eventTitle:  { type: String, default: null },      // ← ADD: snapshot at scan time
  organizerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
  scannedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User',   default: null }, // organizer
  staffId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Staff',  default: null }, // staff member
  scannedByName: { type: String, default: 'organizer' },
  method:      { type: String, enum: ['scan', 'manual'], default: 'manual' },
  result: {
    type: String,
    // Must match every `result` value passed by staffService._log:
    //   'valid' | 'already_used' | 'invalid' | 'wrong_event' |
    //   'refunded' | 'refund_pending' | 'cancelled'
    enum: [
      'valid',
      'already_used',
      'invalid',
      'wrong_event',
      'refunded',
      'refund_pending',
      'cancelled',
    ],
    default: 'valid',
  },
  device:      { type: String, default: null },
  ipAddress:   { type: String, default: null },
  buyerName:   { type: String, default: null },
  buyerEmail:  { type: String, default: null },
  ticketType:  { type: String, default: null },
  scannedAt:   { type: Date, default: Date.now },
});

// ── Indexes ──
// Cover every query in staffService.getScanLogs and any future audit view:
//   find({ organizerId, eventId }).sort({ scannedAt: -1 })   → check-in log modal
//   find({ organizerId }).sort({ scannedAt: -1 })             → all-events log
//   find({ organizerId, scannedByName }).sort({ scannedAt: -1 }) → staff filter
//   find({ ticketId })                                         → per-ticket audit trail
scanLogSchema.index({ eventId: 1, scannedAt: -1 });
scanLogSchema.index({ ticketId: 1 });
scanLogSchema.index({ organizerId: 1, scannedAt: -1 });
scanLogSchema.index({ organizerId: 1, eventId: 1, scannedAt: -1 });
scanLogSchema.index({ organizerId: 1, scannedByName: 1, scannedAt: -1 });

scanLogSchema.virtual('id').get(function () { return this._id.toString(); });
scanLogSchema.set('toJSON',   { virtuals: true });
scanLogSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('ScanLog', scanLogSchema);
