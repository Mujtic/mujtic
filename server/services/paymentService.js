// services/paymentService.js
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const paystack = require('../config/paystack');
const Payment = require('../models/Payment');
const Event = require('../models/Event');
const Ticket = require('../models/Ticket');
const couponService = require('./couponService');
const settingsService = require('./settingsService');
const { sendEmail, sendSMS } = require('./notificationService');
const { AppError } = require('../utils/appError');
const { logger } = require('../config/logger');
const { escapeHtml, sanitizeHeader } = require('../utils/htmlSecurity');

const CALLBACK_PATH = '/api/payments/callback';

class PaymentService {

  // ── STEP 1: initialize — called by frontend before redirect ────────────
  // Locks the price, creates a pending Payment row, then asks Paystack for a
  // hosted checkout URL. No tickets are created here.
  async initializeCharge({
                           eventId, ticketType, quantity,
                           buyerEmail, buyerPhone, buyerName,
                           promoCode = null, groupBooking = null, userId = null,
                         }) {
    if (!eventId || !ticketType || !quantity) {
      throw new AppError('eventId, ticketType, quantity are required', 400);
    }
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1) throw new AppError('quantity must be a positive integer', 400);

    const event = await Event.findById(eventId);
    if (!event) throw new AppError('Event not found', 404);
    if (event.isCancelled) throw new AppError('Event is cancelled', 400);
    if (event.isPublished === false) throw new AppError('Event is not published', 400);

    const tt = event.ticketTypes;
    if (!tt || !(tt instanceof Map)) throw new AppError('Event ticket types corrupted', 500);
    const typeData = tt.get(ticketType);
    if (!typeData) throw new AppError('Invalid ticket type', 400);

    const available = (Number(typeData.capacity) || 0) - (Number(typeData.sold) || 0);
    if (qty > available) throw new AppError(`Only ${available} ticket(s) available`, 400);

    // ── Freeze pricing ──
    // Same rules as ticketService._priceOrder, computed here so the
    // fulfillment step doesn't need to re-derive anything from live DB values.
    const unitFace  = this._facePriceFor(typeData);
    const subtotal  = Math.round(unitFace * qty * 100) / 100;

    let promoDiscount = 0;
    let appliedCoupon = null;
    if (promoCode) {
      try {
        const r = await couponService.applyCoupon(promoCode, String(event._id), subtotal, userId);
        promoDiscount = Math.round(r.discount * 100) / 100;
        appliedCoupon = r.coupon;
      } catch (err) {
        throw new AppError(err.message || 'Invalid promo code', 400);
      }
    }

    const faceTotal = Math.round((subtotal - promoDiscount) * 100) / 100;
    if (faceTotal < 0.01) throw new AppError('Order total must be at least GHS 0.01', 400);

    const money = await settingsService.quoteOrder(faceTotal, event);
    const buyerTotal   = money.buyerTotal;
    const amountPesewas = Math.round(buyerTotal * 100);

    if (amountPesewas < 100) {
      throw new AppError('Order total is below Paystack’s minimum (GHS 1.00). Claim free tickets directly instead.', 400);
    }

    const reference = `MJT-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    const payment = new Payment({
      reference,
      eventId: event._id,
      userId: userId || null,
      ticketType,
      quantity: qty,
      amountGHS: buyerTotal,
      amountPesewas,
      status: 'pending',
      buyerEmail: String(buyerEmail).toLowerCase().trim(),
      buyerPhone: buyerPhone || null,
      buyerName: buyerName || buyerEmail.split('@')[0],
      promoCode: promoCode || null,
      groupBooking: groupBooking || null,
      pricing: {
        faceTotal,
        facePerTicket: Math.round((faceTotal / qty) * 100) / 100,
        discount: promoDiscount,
        appliedCouponId: appliedCoupon?._id || null,
        platformFee:   money.platformFee,
        processingFee: money.processingFee,
        buyerTotal,
        currency: event.currency || 'GHS',
      },
    });
    await payment.save();

    // ── Paystack initialize ──
    let init;
    try {

      // Paystack accepts ISO 4217 currency codes. "GHC" is the deprecated
      // pre-2007 Ghanaian cedi code — events created via the old form store
      // 'GHC', but Paystack only recognises 'GHS'. Normalise at the boundary
      // so existing events keep working without a data migration.
      const rawCurrency      = String(payment.pricing.currency || 'GHS').toUpperCase();
      const paystackCurrency = rawCurrency === 'GHC' ? 'GHS' : rawCurrency;

      init = await paystack.transaction.initialize({
        email: payment.buyerEmail,
        amount: amountPesewas,
        currency: paystackCurrency,
        reference,
        callback_url: `${process.env.FRONTEND_URL || 'https://mujtic.vercel.app'}/?payment_ref=${reference}`,
        channels: ['mobile_money', 'card'],
        metadata: {
          paymentId: String(payment._id),
          eventId: String(event._id),
          eventTitle: event.title,
          ticketType,
          quantity: qty,
          userId: userId || null,
        },
      });
    } catch (err) {
      await Payment.updateOne(
        { _id: payment._id },
        { $set: { status: 'failed', failedReason: `Paystack init: ${err.message}` } }
      );
      logger.error('Paystack initialize failed', { err: err.message, reference });
      throw new AppError('Payment could not be started. Please try again.', 502);
    }

    if (!init?.data?.authorization_url) {
      await Payment.updateOne(
        { _id: payment._id },
        { $set: { status: 'failed', failedReason: 'Paystack returned no authorization_url' } }
      );
      throw new AppError('Payment could not be started. Please try again.', 502);
    }

    payment.paystack.authorizationUrl = init.data.authorization_url;
    payment.paystack.accessCode = init.data.access_code;
    await payment.save();

    return {
      reference,
      authorizationUrl: init.data.authorization_url,
      amountGHS: buyerTotal,
    };
  }

  _facePriceFor(typeData) {
    const now = new Date();
    let unit = Number(typeData.price) || 0;
    if (typeData.earlyBirdEnd && typeData.earlyBirdPrice != null) {
      const ebEnd = new Date(typeData.earlyBirdEnd);
      if (!isNaN(ebEnd) && now < ebEnd) unit = Number(typeData.earlyBirdPrice);
    }
    return unit;
  }

  // ── STEP 2: verify — called from webhook AND from callback verify ──────
  // Idempotent. Double webhook delivery, callback+webhook racing, or a manual
  // retry all converge on: the buyer's tickets are created exactly once.
  async verifyAndFulfill(reference) {
    if (!reference) throw new AppError('reference is required', 400);

    const payment = await Payment.findOne({ reference });
    if (!payment) throw new AppError('Payment not found', 404);

    // Already fulfilled — return existing tickets
    if (payment.status === 'success' && payment.fulfilledAt) {
      return { ok: true, alreadyFulfilled: true, payment };
    }

    // Ask Paystack for the authoritative state. Never trust a redirect query
    // param on its own — Paystack's verify is the only source of truth.
    let verified;
    try {
      verified = await paystack.transaction.verify({ reference });
    } catch (err) {
      logger.error('Paystack verify failed', { err: err.message, reference });
      throw new AppError('Could not verify payment', 502);
    }

    const data = verified?.data;
    if (!data) throw new AppError('Paystack returned no data', 502);

    if (data.status !== 'success') {
      await Payment.updateOne(
        { _id: payment._id },
        { $set: {
            status: data.status === 'abandoned' ? 'abandoned' : 'failed',
            'paystack.gatewayResponse': data.gateway_response || data.status,
            failedReason: data.gateway_response || `Paystack status: ${data.status}`,
          } }
      );
      return { ok: false, status: data.status, payment };
    }

    // Amount tamper check — Paystack reports the amount in pesewas
    if (Number(data.amount) !== payment.amountPesewas) {
      logger.error('Paystack amount mismatch', {
        reference, expected: payment.amountPesewas, received: data.amount,
      });
      await Payment.updateOne(
        { _id: payment._id },
        { $set: { status: 'failed', failedReason: `Amount mismatch: expected ${payment.amountPesewas}, got ${data.amount}` } }
      );
      throw new AppError('Payment amount mismatch', 400);
    }

    // Currency sanity
    if (data.currency && data.currency !== payment.pricing.currency) {
      await Payment.updateOne(
        { _id: payment._id },
        { $set: { status: 'failed', failedReason: `Currency mismatch: expected ${payment.pricing.currency}, got ${data.currency}` } }
      );
      throw new AppError('Payment currency mismatch', 400);
    }

    // Atomically claim the payment (pending → success). Only one caller wins
    // this findOneAndUpdate; the loser falls through and re-reads the state.
    const claimed = await Payment.findOneAndUpdate(
      { _id: payment._id, status: 'pending' },
      { $set: {
          status: 'success',
          'paystack.channel': data.channel,
          'paystack.gatewayResponse': data.gateway_response,
          'paystack.paidAt': new Date(data.paid_at || Date.now()),
          'paystack.ipAddress': data.ip_address,
        } },
      { returnDocument: 'after' }
    );
    if (!claimed) {
      // Someone else claimed it between our read and our write
      const fresh = await Payment.findById(payment._id);
      return { ok: true, alreadyFulfilled: !!fresh?.fulfilledAt, payment: fresh };
    }

    // Fulfill — create tickets, reserve capacity, send emails
    try {
      const result = await this._fulfillTickets(claimed);
      return { ok: true, ...result, payment: claimed };
    } catch (err) {
      logger.error('Ticket fulfillment failed after payment success', {
        reference, err: err.message,
      });
      await Payment.updateOne(
        { _id: claimed._id },
        { $set: { failedReason: `Fulfillment failed: ${err.message}` } }
      );
      throw err;
    }
  }

  async _fulfillTickets(payment) {
    const event = await Event.findById(payment.eventId);
    if (!event) throw new AppError('Event no longer exists', 404);

    if (event.isCancelled) {
      await this._refundViaPaystack(payment, 'Event cancelled before payment completed');
      throw new AppError('Event was cancelled. A refund has been issued.', 400);
    }

    // Atomic capacity reservation
    const soldPath = `ticketTypes.${payment.ticketType}.sold`;
    const typeData = event.ticketTypes?.get?.(payment.ticketType);
    if (!typeData) throw new AppError('Ticket type missing on event', 500);
    const capacity = Number(typeData.capacity) || 0;

    const reserved = await Event.findOneAndUpdate(
      { _id: event._id, [soldPath]: { $lte: capacity - payment.quantity } },
      { $inc: { [soldPath]: payment.quantity } },
      { returnDocument: 'after' }
    );
    if (!reserved) {
      await this._refundViaPaystack(payment, 'Tickets sold out before payment completed');
      throw new AppError('Tickets sold out. A refund has been issued.', 409);
    }

    const ticketDocs = [];
    const ticketIds  = [];
    try {
      const facePrices     = settingsService.allocateFee(payment.pricing.faceTotal,     payment.quantity);
      const platformFees   = settingsService.allocateFee(payment.pricing.platformFee,   payment.quantity);
      const processingFees = settingsService.allocateFee(payment.pricing.processingFee, payment.quantity);

      for (let i = 0; i < payment.quantity; i++) {
        const ticketId = uuidv4();
        const ticket = new Ticket({
          id: ticketId,
          eventId: event._id,
          userId: payment.userId,
          ticketType: payment.ticketType,

          price:         facePrices[i],
          platformFee:   platformFees[i],
          processingFee: processingFees[i],
          feePaidBy:     'organizer',
          amountPaid:    Math.round((facePrices[i] + processingFees[i]) * 100) / 100,

          userEmail:    payment.buyerEmail,
          userPhone:    payment.buyerPhone,
          buyerName:    payment.buyerName,
          companyName:  payment.groupBooking?.companyName || '',
          billingAddress: payment.groupBooking?.billingAddress || '',
          poNumber:     payment.groupBooking?.poNumber || '',

          validated:    false,
          status:       'active',
          promoCode:    payment.promoCode,
          discountAmount: payment.pricing.discount > 0
            ? Math.round((payment.pricing.discount / payment.quantity) * 100) / 100
            : 0,

          // Payment traceability — matches the shape the waitlist conversion uses
          paymentIntentId: payment.reference,
          paymentGateway:  'paystack',
        });
        await ticket.save();
        ticketDocs.push(ticket);
        ticketIds.push(ticketId);
      }
    } catch (err) {
      // Roll back everything so a retry after ops fixes the issue starts clean
      logger.error('Ticket creation failed during Paystack fulfillment — rolling back', {
        err: err.message, reference: payment.reference,
      });
      await Event.updateOne({ _id: event._id }, { $inc: { [soldPath]: -payment.quantity } }).catch(() => {});
      if (ticketDocs.length) {
        await Ticket.deleteMany({ _id: { $in: ticketDocs.map((t) => t._id) } }).catch(() => {});
      }
      throw err;
    }

    await Payment.updateOne(
      { _id: payment._id },
      { $set: { ticketIds, fulfilledAt: new Date() } }
    );

    // Fire-and-forget notifications
    this._sendTicketEmails(event, ticketDocs).catch((err) =>
      logger.error('Paystack ticket email failed', { err: err.message, reference: payment.reference })
    );

    if (payment.pricing.appliedCouponId) {
      couponService.incrementUsage(payment.pricing.appliedCouponId).catch((err) =>
        logger.error('Coupon increment failed after Paystack success', {
          err: err.message, couponId: String(payment.pricing.appliedCouponId),
        })
      );
    }

    return { ticketIds, tickets: ticketDocs };
  }

  async _sendTicketEmails(event, tickets) {
    const subject  = sanitizeHeader(`Your ticket for ${event.title}`);
    const venue    = `${event.venue}${event.location ? ', ' + event.location : ''}`;
    const dateStr  = new Date(event.date).toLocaleString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    for (const t of tickets) {
      const html = `
        <h2>Your Mujtic Ticket</h2>
        <p>Thank you for purchasing a ticket to <strong>${escapeHtml(event.title)}</strong>.</p>
        <p><strong>Ticket ID:</strong> ${escapeHtml(t.id)}</p>
        <p><strong>Type:</strong> ${escapeHtml(String(t.ticketType).toUpperCase())}</p>
        <p><strong>Paid:</strong> GHS ${Number(t.amountPaid).toFixed(2)}</p>
        <p><strong>When:</strong> ${escapeHtml(dateStr)}</p>
        <p><strong>Where:</strong> ${escapeHtml(venue)}</p>
        <p>Present this ticket's QR code at the entrance.</p>
      `;
      const text = `Your Mujtic ticket for ${event.title}. Ticket ID: ${t.id}. Paid: GHS ${Number(t.amountPaid).toFixed(2)}.`;

      sendEmail(t.userEmail, subject, html, text).catch((err) =>
        logger.error('ticket email failed', { ticketId: t.id, err: err.message })
      );
      if (t.userPhone) {
        sendSMS(t.userPhone, `Mujtic: Your ticket for ${event.title} is confirmed. Ticket ID: ${t.id}`).catch(() => {});
      }
    }
  }

  async _refundViaPaystack(payment, reason) {
    try {
      const refund = await paystack.refund.create({
        transaction: payment.reference,
        merchant_note: String(reason).slice(0, 200),
      });
      logger.info('Paystack refund initiated', {
        reference: payment.reference, refundId: refund?.data?.id,
      });
      await Payment.updateOne(
        { _id: payment._id },
        { $set: { status: 'refunded', failedReason: reason } }
      );
    } catch (err) {
      logger.error('Paystack refund failed', { reference: payment.reference, err: err.message });
      // At least flag it for manual reconciliation
      await Payment.updateOne(
        { _id: payment._id },
        { $set: { failedReason: `Refund attempted, manual follow-up needed: ${reason}` } }
      );
    }
  }

  // ── STEP 3: webhook — signed payload from Paystack ────────────────────
  verifyWebhookSignature(rawBody, signature) {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) throw new AppError('PAYSTACK_SECRET_KEY not configured', 500);
    if (!signature) return false;
    const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    if (hash.length !== String(signature).length) return false;
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(String(signature)));
  }

  async handleWebhook(rawBody, signature) {
    if (!this.verifyWebhookSignature(rawBody, signature)) {
      throw new AppError('Invalid webhook signature', 401);
    }

    let payload;
    try { payload = JSON.parse(rawBody.toString()); }
    catch { throw new AppError('Invalid webhook JSON', 400); }

    if (payload.event === 'charge.success') {
      const reference = payload.data?.reference;
      if (!reference) throw new AppError('Missing reference in webhook', 400);
      // Fire-and-forget; verifyAndFulfill is idempotent so the concurrent
      // frontend callback (if it also verifies) can't double-fulfill.
      this.verifyAndFulfill(reference).catch((err) =>
        logger.error('Webhook fulfillment failed', { reference, err: err.message })
      );
    }

    return { received: true, type: payload.event };
  }

  async getPaymentByReference(reference) {
    return Payment.findOne({ reference }).lean();
  }
}

module.exports = new PaymentService();
