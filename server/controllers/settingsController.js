const settingsService = require('../services/settingsService');
const logService = require('../services/logService');
const { AppError } = require('../utils/appError');

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

const snapshot = (s) => ({
  platformFee: s.platformFee,
  platformFeeFloor: s.platformFeeFloor,
  processingFee: s.processingFee,
  processingFeeFloor: s.processingFeeFloor,
  refundDeadlineDays: s.refundDeadlineDays,
});

exports.getSettings = async (req, res, next) => {
  try {
    const settings = await settingsService.getSettings();
    res.json(settings);
  } catch (err) {
    next(err);
  }
};

exports.updateSettings = async (req, res, next) => {
  try {
    if (!req.user?.isAdmin) {
      throw new AppError('Forbidden', 403);
    }

    const updates = req.body || {};

    // Snapshot the current doc so the audit reflects the actual before/after.
    // The service's whitelist (EDITABLE_FIELDS) silently drops unknown keys,
    // so logging the full snapshot is safer than trying to predict which
    // fields will survive.
    const before = await settingsService.getSettings();
    const beforeSnapshot = snapshot(before);

    const settings = await settingsService.updateSettings(updates);

    logService.audit(req.user.email, 'update_settings', 'settings', {
      type: 'system', adminId: req.user.id,
      attemptedFields: Object.keys(updates),
      before: beforeSnapshot,
      after: snapshot(settings),
      ...ctx(req),
    });

    res.json(settings);
  } catch (err) {
    next(err);
  }
};
