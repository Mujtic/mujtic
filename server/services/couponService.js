// services/couponService.js
const Coupon = require('../models/Coupon');
const Event = require('../models/Event');
const { AppError } = require('../utils/appError');

class CouponService {
  async createCoupon(organizerId, couponData) {
    const { code, type, value, expiryDate, usageLimit, eventId } = couponData;

    // --- Input validation ---
    if (!code || typeof code !== 'string') {
      throw new AppError('Coupon code is required', 400);
    }
    if (!['percentage', 'fixed'].includes(type)) {
      throw new AppError('Type must be "percentage" or "fixed"', 400);
    }
    if (typeof value !== 'number' || !isFinite(value) || value <= 0) {
      throw new AppError('Value must be a positive number', 400);
    }
    if (type === 'percentage' && value > 100) {
      throw new AppError('Percentage value cannot exceed 100', 400);
    }
    if (!expiryDate || isNaN(new Date(expiryDate))) {
      throw new AppError('Valid expiry date is required', 400);
    }
    if (new Date(expiryDate) <= new Date()) {
      throw new AppError('Expiry date must be in the future', 400);
    }
    if (usageLimit != null && (!Number.isInteger(usageLimit) || usageLimit < 1)) {
      throw new AppError('Usage limit must be a positive integer', 400);
    }
    if (eventId) {
      const event = await Event.findById(eventId).select('_id').lean();
      if (!event) throw new AppError('Event not found', 404);
    }

    // --- Uniqueness ---
    const normalizedCode = code.trim().toUpperCase();
    const existing = await Coupon.findOne({ code: normalizedCode });
    if (existing) throw new AppError('Coupon code already exists', 409);

    const coupon = new Coupon({
      code: normalizedCode,
      type,
      value,
      expiryDate,
      usageLimit: usageLimit || null,
      eventId: eventId || null,
      organizerId,
    });

    try {
      await coupon.save();
    } catch (err) {
      // Race: another request inserted the same code between findOne and save
      if (err.code === 11000) throw new AppError('Coupon code already exists', 409);
      throw err;
    }

    return coupon;
  }

  async getCoupons(organizerId, filters = {}) {
    const query = { organizerId };
    if (filters.eventId) query.eventId = filters.eventId;
    if (filters.isActive !== undefined) query.isActive = filters.isActive;
    return Coupon.find(query).sort({ createdAt: -1 });
  }

  async getPublicCoupons(eventId = null) {
    const query = { isActive: true, expiryDate: { $gt: new Date() } };
    if (eventId) query.eventId = { $in: [eventId, null] };
    return Coupon.find(query).limit(50);
  }

  async validateCoupon(code, eventId, userId = null) {
    if (!code || typeof code !== 'string') {
      throw new AppError('Invalid coupon code', 400);
    }

    const coupon = await Coupon.findOne({ code: code.trim().toUpperCase() });
    if (!coupon) throw new AppError('Invalid coupon code', 400);
    if (!coupon.isActive) throw new AppError('Coupon is not active', 400);
    if (new Date() > new Date(coupon.expiryDate)) throw new AppError('Coupon has expired', 400);
    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
      throw new AppError('Coupon usage limit reached', 400);
    }

    // Event-scoped coupon must match the request's event (compare as strings)
    if (coupon.eventId) {
      if (!eventId) throw new AppError('Coupon requires an event', 400);
      if (coupon.eventId.toString() !== eventId.toString()) {
        throw new AppError('Coupon not valid for this event', 400);
      }
    }

    return coupon;
  }

  async applyCoupon(code, eventId, subtotal, userId) {
    if (typeof subtotal !== 'number' || !isFinite(subtotal) || subtotal <= 0) {
      throw new AppError('Invalid subtotal', 400);
    }

    const coupon = await this.validateCoupon(code, eventId, userId);

    let discount = 0;
    if (coupon.type === 'percentage') {
      discount = subtotal * (coupon.value / 100);
    } else {
      discount = Math.min(coupon.value, subtotal);
    }

    // Round to 2 decimal places to avoid floating-point drift in totals
    discount = Math.round(discount * 100) / 100;

    return { discount, coupon };
  }

  async incrementUsage(couponId) {
    const coupon = await Coupon.findById(couponId);
    if (!coupon) throw new AppError('Coupon not found', 404);

    // Pre-check so we don't increment past the limit
    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
      throw new AppError('Coupon usage limit reached', 400);
    }

    coupon.usedCount += 1;
    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
      coupon.isActive = false;
    }
    await coupon.save();
    return coupon;
  }

  async deleteCoupon(couponId, organizerId, isAdmin = false) {
    if (typeof couponId !== 'string' || !/^[a-f\d]{24}$/i.test(couponId)) {
      throw new AppError('Coupon not found', 404);
    }

    const coupon = await Coupon.findById(couponId);
    if (!coupon) throw new AppError('Coupon not found', 404);

    if (!isAdmin && coupon.organizerId.toString() !== organizerId.toString()) {
      throw new AppError('You do not have permission to delete this coupon', 403);
    }

    const info = { code: coupon.code, eventId: coupon.eventId };
    await coupon.deleteOne();
    return info;
  }
}

module.exports = new CouponService();
