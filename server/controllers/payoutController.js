const payoutService = require('../services/payoutService');
const logService = require('../services/logService');

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

exports.requestPayout = async (req, res, next) => {
  try {
    const payout = await payoutService.requestPayout(req.user.id, req.body || {});
    // Amount and method only: account numbers, phone numbers, and notes
    // are never included in the audit log.
    const payoutId = String(payout?._id || payout?.id || '');
    logService.audit(req.user.email, 'request_payout', payoutId, {
      type: 'payout',
      adminId: req.user.id,
      payoutId,
      amount: req.body?.amount,
      method: payout?.method || req.body?.method,
      ...ctx(req),
    });
    res.status(201).json(payout);
  } catch (err) {
    next(err);
  }
};

exports.getMyPayouts = async (req, res, next) => {
  try {
    const payouts = await payoutService.getMyPayouts(req.user.id);
    res.json(payouts);
  } catch (err) {
    next(err);
  }
};

// NOTE: approvePayout and rejectPayout were removed from this controller.
// Admin payout approval/rejection lives in adminController (which calls
// adminService.approvePayout / adminService.rejectPayout, delegating to
// payoutService with the correct guards). Having a second path here
// previously contained a parseInt(ObjectId) bug that made every approval
// and rejection fail. Single canonical path = safer.
