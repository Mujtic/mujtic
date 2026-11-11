const couponService = require('../services/couponService');
const logService = require('../services/logService');
const Coupon = require('../models/Coupon'); // only used to read the code before it is deleted

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

// Organizer: Create coupon
exports.createCoupon = async (req, res, next) => {
  try {
    const { code, type, value, expiryDate, usageLimit, eventId } = req.body || {};
    const coupon = await couponService.createCoupon(req.user.id, {
      code, type, value, expiryDate, usageLimit, eventId,
    });
    logService.audit(req.user.email, 'create_coupon', coupon?.code || code, {
      type: 'event', adminId: req.user.id,
      couponType: type, value, usageLimit, eventId, ...ctx(req),
    });
    res.status(201).json(coupon);
  } catch (err) {
    next(err);
  }
};

// Organizer: Get my coupons
exports.getMyCoupons = async (req, res, next) => {
  try {
    // Query strings are HTTP-level input — coerce to typed values here so
    // the service deals with real booleans, not the strings 'true'/'false'.
    const isActive = req.query.isActive === 'true' ? true
      : req.query.isActive === 'false' ? false
        : undefined;

    const coupons = await couponService.getCoupons(req.user.id, {
      eventId: req.query.eventId,
      isActive,
    });
    res.json(coupons);
  } catch (err) {
    next(err);
  }
};

// Public: Get active coupons (for a specific event)
exports.getPublicCoupons = async (req, res, next) => {
  try {
    const coupons = await couponService.getPublicCoupons(req.query.eventId);
    res.json(coupons);
  } catch (err) {
    next(err);
  }
};

// Public: Validate a coupon code
exports.validateCoupon = async (req, res, next) => {
  try {
    const { code, eventId } = req.body || {};
    const coupon = await couponService.validateCoupon(code, eventId, req.user?.id);
    res.json({
      valid: true,
      code: coupon.code,
      type: coupon.type,
      value: coupon.value,
    });
  } catch (err) {
    next(err);
  }
};

// Authenticated: Apply coupon to calculate discount
exports.applyCoupon = async (req, res, next) => {
  try {
    const { code, eventId, subtotal } = req.body || {};
    const { discount, coupon } = await couponService.applyCoupon(
      code, eventId, subtotal, req.user?.id
    );
    res.json({
      discount: discount.toFixed(2),
      finalTotal: (subtotal - discount).toFixed(2),
      coupon: {
        code: coupon.code,
        type: coupon.type,
        value: coupon.value,
      },
    });
  } catch (err) {
    next(err);
  }
};

// Admin/Organizer: Delete coupon
exports.deleteCoupon = async (req, res, next) => {
  try {
    const { id } = req.params;
    const isAdmin = req.user.role === 'admin';

    const deleted = await couponService.deleteCoupon(id, req.user.id, isAdmin);

    logService.audit(req.user.email, 'delete_coupon', deleted.code, {
      type: 'event', adminId: req.user.id, couponId: id, eventId: deleted.eventId, ...ctx(req),
    });

    res.status(200).json({ ok: true, id });
  } catch (err) {
    next(err);
  }
};
