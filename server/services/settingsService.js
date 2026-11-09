// services/settingsService.js
const Settings = require('../models/Settings');
const { AppError } = require('../utils/appError');
const { logger } = require('../config/logger');

// Fields an admin is allowed to update via this API.
// Anything not listed is silently ignored.
//
// Two independent fee tracks:
//
//   ORGANIZER side (deducted from payout):
//     platformFee      → the percentage
//     platformFeeFloor → minimum fee per order, in cedis (0 = no minimum)
//
//   BUYER side (added on top at checkout, always):
//     processingFee      → the percentage
//     processingFeeFloor → minimum fee per order, in cedis (0 = no minimum)
//
// To add a field: (1) add to this list, (2) add a validator below,
// (3) add the field to models/Settings.js, AND (4) read it from the
// relevant service.
const EDITABLE_FIELDS = [
  'platformFee',
  'platformFeeFloor',
  'processingFee',
  'processingFeeFloor',
  'refundDeadlineDays',
];

// The minimum fee is written in cedis, so it only applies to events priced in
// cedis. Events in other currencies pay the percentage only.
const FLOOR_CURRENCY = 'GHC';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const validators = {
  platformFee: (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 50) {
      throw new AppError('platformFee must be a number between 0 and 50', 400);
    }
  },
  platformFeeFloor: (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 50) {
      throw new AppError('platformFeeFloor must be a number of cedis between 0 and 50', 400);
    }
  },
  processingFee: (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 50) {
      throw new AppError('processingFee must be a number between 0 and 50', 400);
    }
  },
  processingFeeFloor: (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 50) {
      throw new AppError('processingFeeFloor must be a number of cedis between 0 and 50', 400);
    }
  },
  refundDeadlineDays: (v) => {
    if (!Number.isInteger(v) || v < 1 || v > 90) {
      throw new AppError('refundDeadlineDays must be an integer between 1 and 90', 400);
    }
  },
};

class SettingsService {
  async getSettings() {
    // Atomic upsert — prevents the race where two concurrent requests both
    // find nothing and both create a settings doc (leaving duplicates behind).
    return Settings.findOneAndUpdate(
      {},
      {
        $setOnInsert: {
          platformFee: 3,
          platformFeeFloor: 0,
          processingFee: 0,
          processingFeeFloor: 0,
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
  }

  async updateSettings(updates) {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new AppError('Settings updates must be an object', 400);
    }

    // Reject prototype-pollution keys before anything else
    for (const key of Object.keys(updates)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new AppError('Invalid settings update', 400);
      }
    }

    // Build a clean patch: whitelist + validate each field
    const clean = {};
    for (const [key, value] of Object.entries(updates)) {
      if (!EDITABLE_FIELDS.includes(key)) continue; // unknown fields silently dropped
      validators[key]?.(value);                     // throws AppError on invalid value
      clean[key] = value;
    }

    if (Object.keys(clean).length === 0) {
      throw new AppError('No valid settings fields to update', 400);
    }

    const settings = await this.getSettings();

    // Capture pre-update values for the audit log
    const before = {};
    for (const key of Object.keys(clean)) before[key] = settings[key];

    settings.set(clean);
    settings.updatedAt = new Date();
    await settings.save();

    logger.info('Settings updated', {
      changedFields: Object.keys(clean),
      before,
      after: clean,
    });

    return settings;
  }

  // ── fee calculation ─────────────────────────────────────────────

  // Shared pure calculator (works in minor units to avoid float drift).
  // Fee = MAX(percentageFee, floorFee), capped at the order total.
  computeFeeMinor(totalMinor, percent, floorCedis, currency) {
    const percentFee = Math.round(totalMinor * percent / 100);
    const floorFee = String(currency || '').toUpperCase() === FLOOR_CURRENCY
      ? Math.round((Number(floorCedis) || 0) * 100)
      : 0;
    return Math.min(totalMinor, Math.max(percentFee, floorFee));
  }

  // Platform fee — organizer pays, deducted from their payout.
  computePlatformFee(amount, currency, settings) {
    const total = Number(amount);
    if (!Number.isFinite(total) || total <= 0) return 0;
    return this.computeFeeMinor(
      Math.round(total * 100),
      Number(settings?.platformFee) || 0,
      Number(settings?.platformFeeFloor) || 0,
      currency
    ) / 100;
  }

  // Processing fee — buyer pays, added on top of the ticket price.
  computeProcessingFee(amount, currency, settings) {
    const total = Number(amount);
    if (!Number.isFinite(total) || total <= 0) return 0;
    return this.computeFeeMinor(
      Math.round(total * 100),
      Number(settings?.processingFee) || 0,
      Number(settings?.processingFeeFloor) || 0,
      currency
    ) / 100;
  }

  // Back-compat alias — this used to be the only fee.
  computeFee(amount, currency, settings) {
    return this.computePlatformFee(amount, currency, settings);
  }

  async calculatePlatformFee(amount, currency = FLOOR_CURRENCY) {
    const settings = await this.getSettings();
    return this.computePlatformFee(amount, currency, settings);
  }

  async calculateProcessingFee(amount, currency = FLOOR_CURRENCY) {
    const settings = await this.getSettings();
    return this.computeProcessingFee(amount, currency, settings);
  }

  // Splits an amount across tickets so the parts add up exactly
  // (for example 1.00 over 3 tickets → 0.34, 0.33, 0.33).
  allocateFee(totalFee, count) {
    const n = Math.floor(Number(count));
    if (!(n >= 1)) return [];
    const minor = Math.round(Number(totalFee) * 100) || 0;
    const base = Math.floor(minor / n);
    const remainder = minor - base * n;
    return Array.from({ length: n }, (_, i) => (base + (i < remainder ? 1 : 0)) / 100);
  }

  // Everything both sides need to know about one order's money. `faceTotal`
  // is the ticket value after discounts (what the organizer priced).
  //   platformFee    → deducted from the organizer
  //   processingFee  → added on top of the buyer's total (ALWAYS)
  //   serviceFee     → what the buyer sees as an extra line (== processingFee)
  //   buyerTotal     → faceTotal + processingFee
  //   organizerNet   → faceTotal - platformFee
  async quoteOrder(faceTotal, event) {
    const settings = await this.getSettings();
    const face = round2(faceTotal);
    const platformFee = this.computePlatformFee(face, event?.currency, settings);
    const processingFee = this.computeProcessingFee(face, event?.currency, settings);

    return {
      faceTotal: face,
      platformFee,
      processingFee,
      serviceFee: processingFee,
      buyerTotal: round2(face + processingFee),
      organizerNet: round2(face - platformFee),

      // Back-compat for any caller that only knows about `fee` / `feePaidBy`.
      fee: processingFee,
      feePaidBy: 'buyer',
    };
  }
}

module.exports = new SettingsService();
