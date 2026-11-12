// services/ticketService.js
const { v4: uuidv4 } = require('uuid');
const Ticket  = require('../models/Ticket');
const Event   = require('../models/Event');
const User    = require('../models/User');
const Refund  = require('../models/Refund');
const Coupon  = require('../models/Coupon');
const { sendEmail, sendSMS } = require('./notificationService');
const couponService = require('./couponService');
const settingsService = require('./settingsService');
const { AppError } = require('../utils/appError');
const { logger } = require('../config/logger');
const { escapeHtml, sanitizeHeader } = require('../utils/htmlSecurity');
const { isObjectIdString } = require('../utils/validators');

const MAX_QUANTITY_PER_ORDER = 50;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

class TicketService {
  // ── shared steps (used by both the quote and the purchase) ──────

  _validateOrderInput(eventId, ticketType, quantity) {
    if (!eventId) throw new AppError('eventId is required', 400);
    if (!isObjectIdString(String(eventId))) throw new AppError('Invalid event', 400);
    if (!ticketType || typeof ticketType !== 'string') {
      throw new AppError('ticketType is required', 400);
    }
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY_PER_ORDER) {
      throw new AppError(
        `quantity must be an integer between 1 and ${MAX_QUANTITY_PER_ORDER}`, 400
      );
    }
    return qty;
  }

  async _loadSellableEvent(eventId) {
    const event = await Event.findById(eventId);
    if (!event) throw new AppError('Event not found', 404);
    if (event.isCancelled) throw new AppError('Event cancelled', 400);
    if (event.isPublished === false) throw new AppError('Event is not published', 400);
    return event;
  }

  // Ticket value after early-bird, group and promo discounts (the amount the
  // organizer is paid for), before any platform fee.
  async _priceOrder(event, ticketType, qty, promoCode, userId) {
    const ticketTypes = event.ticketTypes;
    if (!ticketTypes || !(ticketTypes instanceof Map)) {
      throw new AppError('Event ticket types are corrupted', 500);
    }

    const typeData = ticketTypes.get(ticketType);
    if (!typeData) throw new AppError('Invalid ticket type', 400);

    const capacity = Number(typeData.capacity) || 0;
    const sold = Number(typeData.sold) || 0;
    const available = capacity - sold;
    if (qty > available) {
      throw new AppError(`Only ${available} ticket(s) available`, 400);
    }

    // ── Pricing ──
    const now = new Date();
    let unitPrice = Number(typeData.price) || 0;

    if (typeData.earlyBirdEnd && typeData.earlyBirdPrice != null) {
      const ebEnd = new Date(typeData.earlyBirdEnd);
      if (!isNaN(ebEnd) && now < ebEnd) {
        unitPrice = Number(typeData.earlyBirdPrice);
      }
    }

    const subtotal = round2(unitPrice * qty);

    const minQty = Number(typeData.groupDiscountMinQty) || 5;
    const discPct = Number(typeData.groupDiscount) || 0;
    let groupDiscount = 0;
    let groupDiscountApplied = false;
    if (discPct > 0 && discPct <= 100 && qty >= minQty) {
      groupDiscount = round2(subtotal * discPct / 100);
      groupDiscountApplied = true;
    }
    const afterGroup = round2(subtotal - groupDiscount);

    // ── Promo code ──
    let promoDiscount = 0;
    let appliedCoupon = null;
    if (promoCode) {
      const { discount, coupon } = await couponService.applyCoupon(
        promoCode, String(event._id), afterGroup, userId
      );
      promoDiscount = round2(discount);
      appliedCoupon = coupon;
    }

    return {
      capacity, subtotal, groupDiscount, groupDiscountApplied, discPct,
      promoDiscount, appliedCoupon,
      faceTotal: round2(afterGroup - promoDiscount),
    };
  }

  // ── checkout quote ──────────────────────────────────────────────
  // The all-in price, shown to the buyer BEFORE they pay: ticket price,
  // discounts, the buyer-paid processing fee, and the total.
  // Uses exactly the same pricing as the purchase, so the two cannot differ.
  // The organizer-paid platform fee is intentionally NOT exposed here.
  async quotePurchase({ eventId, ticketType, quantity, promoCode } = {}, userId = null) {
    const qty = this._validateOrderInput(eventId, ticketType, quantity);
    const event = await this._loadSellableEvent(eventId);
    const priced = await this._priceOrder(event, ticketType, qty, promoCode, userId);
    const money = await settingsService.quoteOrder(priced.faceTotal, event);

    const labels = [];
    if (priced.groupDiscountApplied) labels.push(`Group ${priced.discPct}%`);
    if (priced.appliedCoupon) labels.push(priced.appliedCoupon.code || promoCode);

    return {
      currency: event.currency,
      quantity: qty,
      unitPrice: round2(priced.subtotal / qty),
      subtotal: priced.subtotal,
      discount: round2(priced.groupDiscount + priced.promoDiscount),
      discountLabel: labels.join(' + '),
      processingFee: money.processingFee,   // buyer-paid
      serviceFee: money.processingFee,      // kept for frontend back-compat
      total: money.buyerTotal,
    };
  }

  // ── purchase ────────────────────────────────────────────────────

  async purchaseTicket(
    userId = null, eventId, ticketType, quantity, paymentDetails,
    groupBooking = {}, promoCode = null, buyerName = null
  ) {
    const qty = this._validateOrderInput(eventId, ticketType, quantity);

    if (!paymentDetails || typeof paymentDetails !== 'object') {
      throw new AppError('paymentDetails is required', 400);
    }
    if (!paymentDetails.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(paymentDetails.email)) {
      throw new AppError('Valid email is required for ticket', 400);
    }
    if (!paymentDetails.phone) {
      throw new AppError('Phone number is required for ticket', 400);
    }

    const event = await this._loadSellableEvent(eventId);
    const priced = await this._priceOrder(event, ticketType, qty, promoCode, userId);
    const { capacity, appliedCoupon, promoDiscount, faceTotal } = priced;

    // The money for this order, worked out once and written onto every ticket:
    // a later change to the fee settings never touches past sales.
    //
    // Two independent fee tracks:
    //   platformFee   → ORGANIZER-paid, deducted from payout
    //   processingFee → BUYER-paid, added on top of the face price
    const money = await settingsService.quoteOrder(faceTotal, event);

    const facePrices     = settingsService.allocateFee(money.faceTotal,     qty);   // sums to face total
    const platformFees   = settingsService.allocateFee(money.platformFee,   qty);   // sums to organizer-paid total
    const processingFees = settingsService.allocateFee(money.processingFee, qty);   // sums to buyer-paid total

    // ── Atomically reserve capacity ──
    const soldPath = `ticketTypes.${ticketType}.sold`;
    const reserved = await Event.findOneAndUpdate(
      { _id: eventId, [soldPath]: { $lte: capacity - qty } },
      { $inc: { [soldPath]: qty } },
      { returnDocument: 'after' }
    );
    if (!reserved) {
      throw new AppError('Not enough tickets available (concurrent purchase)', 409);
    }

    // ── Increment coupon usage BEFORE creating tickets ──
    if (appliedCoupon) {
      try {
        await couponService.incrementUsage(appliedCoupon._id);
      } catch (err) {
        await Event.updateOne({ _id: eventId }, { $inc: { [soldPath]: -qty } });
        throw new AppError(
          `Promo code error: ${err.message}`,
          err.statusCode || 400
        );
      }
    }

    // Resolve buyer display name once (not per ticket)
    const resolvedBuyerName =
      buyerName
      || (userId ? (await User.findById(userId).select('name').lean())?.name : null)
      || (paymentDetails.email ? paymentDetails.email.split('@')[0] : null);

    // ── Create tickets (with rollback on failure) ──
    const purchasedTickets = [];
    try {
      for (let i = 0; i < qty; i++) {
        const ticket = new Ticket({
          id: uuidv4(),
          eventId,
          userId,
          ticketType,

          price: facePrices[i],                            // face price
          platformFee: platformFees[i],                    // ORGANIZER-paid
          processingFee: processingFees[i],                // BUYER-paid
          // Legacy field: with the split, the ticket always still carries an
          // organizer-paid fee, so we record 'organizer'. Downstream code
          // should prefer the platformFee / processingFee fields directly.
          feePaidBy: 'organizer',
          amountPaid: round2(facePrices[i] + processingFees[i]),

          userEmail: paymentDetails.email.toLowerCase().trim(),
          userPhone: paymentDetails.phone,
          buyerName: resolvedBuyerName,
          companyName:     (groupBooking && groupBooking.companyName)     || '',
          billingAddress:  (groupBooking && groupBooking.billingAddress)  || '',
          poNumber:        (groupBooking && groupBooking.poNumber)        || '',
          validated: false,
          status: 'active',
          promoCode: promoCode || null,
          discountAmount: promoDiscount > 0 ? round2(promoDiscount / qty) : 0,
        });
        await ticket.save();
        purchasedTickets.push(ticket);
      }
    } catch (err) {
      logger.error('Ticket creation failed mid-loop — rolling back', {
        eventId, ticketType, qty, createdCount: purchasedTickets.length, err: err.message,
      });
      await Event.updateOne({ _id: eventId }, { $inc: { [soldPath]: -qty } })
        .catch((e) => logger.error('Rollback capacity failed', { err: e.message }));
      if (purchasedTickets.length > 0) {
        await Ticket.deleteMany({ _id: { $in: purchasedTickets.map((t) => t._id) } })
          .catch((e) => logger.error('Rollback ticket delete failed', { err: e.message }));
      }
      if (appliedCoupon) {
        await Coupon.updateOne({ _id: appliedCoupon._id }, { $inc: { usedCount: -1 } })
          .catch((e) => logger.error('Rollback coupon decrement failed', { err: e.message }));
      }
      throw err;
    }

    // ── Build discount description ──
    let discountDesc = '';
    if (priced.groupDiscountApplied && promoDiscount > 0) {
      discountDesc = `Group discount (${priced.discPct}%) + Promo code (${appliedCoupon?.code || promoCode}) applied: -₵${(priced.groupDiscount + promoDiscount).toFixed(2)}`;
    } else if (priced.groupDiscountApplied) {
      discountDesc = `Group discount (${priced.discPct}%) applied: -₵${priced.groupDiscount.toFixed(2)}`;
    } else if (promoDiscount > 0) {
      discountDesc = `Promo code ${appliedCoupon?.code || promoCode} applied: -₵${promoDiscount.toFixed(2)}`;
    }
    const feeDesc = money.processingFee > 0
      ? `Processing fee: ₵${money.processingFee.toFixed(2)}`
      : '';

    // ── Notify buyer — fire-and-forget ──
    const subjectSafe = sanitizeHeader(`Your Ticket for ${event.title}`);
    for (const ticket of purchasedTickets) {
      const emailHtml = `
        <h2>Your Glycr Ticket</h2>
        <p>Thank you for purchasing a ticket to <strong>${escapeHtml(event.title)}</strong>.</p>
        ${discountDesc ? `<p style="color:#3dbb86;">${escapeHtml(discountDesc)}</p>` : ''}
        ${feeDesc ? `<p>${escapeHtml(feeDesc)}</p>` : ''}
        <p><strong>Order total:</strong> ₵${money.buyerTotal.toFixed(2)}</p>
        <p>Ticket ID: ${escapeHtml(ticket.id)}</p>
        <p>Type: ${escapeHtml(ticket.ticketType.toUpperCase())}</p>
        <p>Paid for this ticket: ₵${ticket.amountPaid.toFixed(2)}</p>
        <p>Date: ${new Date(event.date).toLocaleString()}</p>
        <p>Venue: ${escapeHtml(event.venue)}, ${escapeHtml(event.location)}</p>
        <p>Present this QR code at the entrance.</p>
      `;
      const emailText = `Your Glycr Ticket for ${event.title}. Ticket ID: ${ticket.id}. Paid: ₵${ticket.amountPaid.toFixed(2)}. Date: ${new Date(event.date).toLocaleString()}. Venue: ${event.venue}, ${event.location}.${discountDesc ? ` ${discountDesc}` : ''}${feeDesc ? ` ${feeDesc}.` : ''}`;
      const smsText = `Glycr: Your ticket for ${event.title} (${ticket.ticketType}) is confirmed. Ticket ID: ${ticket.id}. Show this QR code at the entrance.`;

      sendEmail(ticket.userEmail, subjectSafe, emailHtml, emailText)
        .catch((err) => logger.error('Ticket email failed', { ticketId: ticket.id, err: err.message }));
      sendSMS(ticket.userPhone, smsText)
        .catch((err) => logger.error('Ticket SMS failed', { ticketId: ticket.id, err: err.message }));
    }

    return purchasedTickets;
  }


  async getUserTickets(userId) {
    if (!userId) throw new AppError('userId is required', 400);
    return Ticket.find({ userId }).populate('eventId', 'title currency');
  }

  // Low-level atomic check-in. Assumes the caller has already verified
  // that eventId belongs to the requester (organizer or admin). Used by
  // staffService-style flows and by validateTicket below.
  async validateTicketAtDoor(ticketId, eventId) {
    if (!ticketId) throw new AppError('ticketId is required', 400);
    if (!eventId)  throw new AppError('eventId is required', 400);

    const ticket = await Ticket.findOne({ id: ticketId });
    if (!ticket) throw new AppError('Ticket not found', 404);
    if (ticket.eventId.toString() !== eventId.toString()) {
      throw new AppError('Ticket not for this event', 400);
    }
    if (ticket.status === 'refunded' || ticket.refunded) {
      throw new AppError('This ticket has been refunded', 400);
    }
    if (ticket.status === 'refund_pending') {
      throw new AppError('This ticket has a pending refund', 400);
    }
    if (ticket.status === 'cancelled') {
      throw new AppError('This ticket has been cancelled', 400);
    }

    const updated = await Ticket.findOneAndUpdate(
      { _id: ticket._id, status: 'active', validated: false },
      { $set: { status: 'used', validated: true, validatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!updated) throw new AppError('Ticket already used', 409);
    return updated;
  }

  // Manual validation by admin / organizer. Derives eventId from the ticket
  // itself, then verifies the requester's authority, then delegates to the
  // same atomic check-in used by staff door scans.
  //
  // actingUser: { id, isAdmin } — the JWT-decoded user making the request.
  async validateTicket(ticketId, actingUser) {
    if (!ticketId) throw new AppError('ticketId is required', 400);
    if (!actingUser || !actingUser.id) {
      throw new AppError('Authentication required', 401);
    }

    const existing = await Ticket.findOne({ id: ticketId })
      .populate('eventId', 'organizerId')
      .lean();
    if (!existing) throw new AppError('Ticket not found', 404);

    if (!existing.eventId) {
      throw new AppError('Event for this ticket no longer exists', 404);
    }

    // Authority: admin can validate any ticket; organizer only their own events.
    if (!actingUser.isAdmin) {
      const organizerId = existing.eventId.organizerId;
      if (!organizerId || String(organizerId) !== String(actingUser.id)) {
        throw new AppError('Forbidden', 403);
      }
    }

    const eventId = String(existing.eventId._id || existing.eventId);
    return this.validateTicketAtDoor(ticketId, eventId);
  }

  // Admin / organizer cancellation. Same authority model as validateTicket:
  // admin any ticket, organizer only their own event's tickets.
  //
  // Refund policy:
  //   - Both fees are refundable with the ticket.
  //   - amountPaid already includes the buyer-paid processing fee, so
  //     refunding it in full returns exactly what the buyer spent.
  //   - If the business ever decides the processing fee should be retained
  //     on cancellation, change `paid` to `round2(ticket.price + ticket.platformFee)`
  //     or similar — and update this comment so the decision is auditable.
  async cancelTicket(ticketId, actingUser) {
    if (!ticketId) throw new AppError('ticketId is required', 400);
    if (!actingUser || !actingUser.id) {
      throw new AppError('Authentication required', 401);
    }

    const ticket = await Ticket.findOne({ id: ticketId }).populate('eventId');
    if (!ticket) throw new AppError('Ticket not found', 404);
    if (!ticket.eventId) throw new AppError('Event for this ticket no longer exists', 404);

    // Authority check
    if (!actingUser.isAdmin) {
      const organizerId = ticket.eventId.organizerId;
      if (!organizerId || String(organizerId) !== String(actingUser.id)) {
        throw new AppError('Forbidden', 403);
      }
    }

    // Atomic lock — prevents double-cancel creating two refunds
    const locked = await Ticket.findOneAndUpdate(
      { _id: ticket._id, status: 'active' },
      { $set: { status: 'refund_pending' } },
      { returnDocument: 'after' }
    );
    if (!locked) throw new AppError('Ticket already used, cancelled, or refunded', 400);

    // amountPaid = price + processingFee, so this refunds both the ticket
    // value and the buyer-paid processing fee (see policy comment above).
    const paid = round2(ticket.amountPaid ?? ticket.price);

    let refund;
    try {
      refund = new Refund({
        ticketId: ticket._id,
        userId: ticket.userId,
        eventId: ticket.eventId._id,
        amount: paid,
        reason: actingUser.isAdmin
          ? 'Cancelled by admin'
          : 'Cancelled by organizer',
        status: 'pending',
        source: 'admin_cancelled',
        requestedAt: new Date(),
        isPartial: false,
        originalPrice: paid,
      });
      await refund.save();

      locked.refundId = refund._id;
      await locked.save();
    } catch (err) {
      await Ticket.updateOne(
        { _id: ticket._id, status: 'refund_pending' },
        { $set: { status: 'active' } }
      ).catch((e) => logger.error('cancelTicket rollback failed', { err: e.message }));
      throw err;
    }

    // Notify organizer — best effort
    const organizer = await User.findById(ticket.eventId.organizerId).select('email').lean();
    if (organizer?.email) {
      const subject = sanitizeHeader(`Refund request created for ${ticket.eventId.title}`);
      const html = `<p>A ticket (${escapeHtml(ticket.id)}) was cancelled by admin and a refund request is pending your review.</p>`;
      sendEmail(organizer.email, subject, html).catch((err) =>
        logger.error('cancelTicket organizer email failed', {
          refundId: refund._id.toString(), err: err.message,
        })
      );
    }

    return refund;
  }




  async getEventTickets(eventId, organizerId = null, { ticketType, limit = 5000 } = {}) {
    if (!eventId) throw new AppError('eventId is required', 400);
    if (organizerId) {
      const owns = await Event.exists({ _id: eventId, organizerId });
      if (!owns) throw new AppError('Event not found or not yours', 403);
    }
    const filter = { eventId };
    if (ticketType) filter.ticketType = ticketType;
    return Ticket.find(filter).limit(limit).lean();
  }
}




module.exports = new TicketService();
