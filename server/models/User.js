const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  username: {
    type: String,
    unique: true,
    sparse: true,
    lowercase: true,
    trim: true,
    minlength: 3,
    maxlength: 30,
    match: /^[a-z0-9_.]+$/,
  },
  password: { type: String, required: true, select: false },
  phone: { type: String, required: true, match: /^\+233\d{9}$/ },
  role: { type: String, enum: ['customer', 'organizer', 'moderator', 'admin'], default: 'customer' },
  isOrganizer: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  suspended: { type: Boolean, default: false },   // admin action — the user cannot undo it
  // Self-service deactivation. Unlike `suspended`, signing in again clears it.
  deactivatedAt: { type: Date, default: null },
  // Self-service deletion: set when the user requests it. Cleared on login.
  // The cron anonymizes the account once this passes AND deletedAt is null.
  deleteScheduledFor: { type: Date, default: null },
  // Set only by the cron when the anonymize actually runs.
  deletedAt: { type: Date, default: null },
  // When the user ticked "I agree to the Terms of Service and Privacy Policy" at sign-up.
  termsAcceptedAt: { type: Date, default: null },
  currency: { type: String, default: 'GHC' },
  passwordChangedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  failedLoginAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null },
});

// ── Indexes ──
userSchema.index({ role: 1 });
userSchema.index({ isOrganizer: 1, suspended: 1 });
userSchema.index({ suspended: 1 });
// Cron scans for due deletions — sparse because most users have `null`.
userSchema.index({ deleteScheduledFor: 1 }, { sparse: true });

userSchema.virtual('id').get(function() { return this._id.toString(); });
userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });
userSchema.virtual('isLocked').get(function() {
  return this.lockUntil && this.lockUntil > Date.now();
});

module.exports = mongoose.model('User', userSchema);
