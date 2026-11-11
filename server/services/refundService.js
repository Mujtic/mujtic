// services/refundService.js
const Refund = require('../models/Refund');
const Ticket = require('../models/Ticket');
const Event = require('../models/Event');
const User = require('../models/User');
const settingsService = require('./settingsService');
const { sendEmail, sendSMS } = require('./notificationService');
const { AppError } = require('../utils/appError');
const { logger } = require('../config/logger');
const { escapeHtml, sanitizeHeader } = require('../utils/htmlSecurity');
const { isObjectIdString } = require('../utils/validators');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// What the buyer actually paid for this ticket — face price plus the
// buyer-paid processing fee (new tickets) or the buyer-paid platform fee
// (legacy tickets). Falls back to price for very old tickets that never
// recorded amountPaid. Used everywhere a refund amount is calculated so the
// "you get back what you paid" policy is applied consistently.
const buyerPaid = (ticket) => round2(ticket?.amountPaid ?? ticket?.price ?? 0);

class RefundService {
  async requestRefund(userId, ticketId, reason, isPartial = false, partialAmount = null) {
    if (!ticketId || typeof ticketId !== 'string') {
      throw new AppError('ticketId is required', 400);
    }
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      throw new AppError('Refund reason is required', 400);
    }
    if (!userId) {
      throw new AppError('userId is required', 400);
    }

    const ticket = await Ticket.findOne({ id: ticketId }).populate('eventId');
    if (!ticket) throw new AppError('Ticket not found', 404);

    if (!ticket.userId) {
      throw new AppError(
        'Guest tickets cannot request refunds via account. Please contact support.',
        403
      );
    }
    if (ticket.userId.toString() !== userId.toString()) {
      throw new AppError('This ticket does not belong to you', 403);
    }

    if (ticket.status === 'refund_pending') {
      throw new AppError('A refund request for this ticket is already pending', 409);
    }

    if (ticket.status === 'cancelled') {
      throw new AppError(
        'This ticket was cancelled together with its event and is being refunded automatically',
        409
      );
    }
    if (ticket.status !== 'active') {
      throw new AppError('Ticket already used, cancelled, or refunded', 400);
    }
    if (ticket.refunded) {
      throw new AppError('Refund already requested', 409);
    }

    // Free / under-₵1 tickets are not refundable.
    if ((Number(ticket.price) || 0) < 1) {
      throw new AppError(
        "Tickets priced under ₵1 (including free tickets) can't be refunded.",
        400
      );
    }

    const event = ticket.eventId;
    if (!event) {
      throw new AppError('Event for this ticket no longer exists', 404);
    }

    if (event.isCancelled) {                                   // ← new
      throw new AppError(
        'This event was cancelled and your ticket is being refunded automatically',
        409
      );
    }

    // Refund window check — reads the configurable deadline from Settings.
    const settings = await settingsService.getSettings();
    const deadlineDays = Number(settings.refundDeadlineDays) || 7;
    const windowMs = deadlineDays * 24 * 60 * 60 * 1000;

    const eventDate = new Date(event.date);
    if (isNaN(eventDate)) {
      throw new AppError('Event has an invalid date', 500);
    }
    const refundDeadline = new Date(eventDate.getTime() - windowMs);
    if (new Date() > refundDeadline) {
      throw new AppError(
        `Refund window has passed (must be at least ${deadlineDays} day${deadlineDays !== 1 ? 's' : ''} before event)`,
        400
      );
    }

    // --- Amount calculation ---
    // Refund the full amount the buyer paid (face price + buyer-paid fee).
    // Partial refunds are validated against the same ceiling so the buyer
    // can't ask for more than they paid.
    const fullAmount = buyerPaid(ticket);
    let amount = fullAmount;
    if (isPartial) {
      const parsed = Number(partialAmount);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > fullAmount) {
        throw new AppError(`Partial amount must be between 0 and ${fullAmount}`, 400);
      }
      amount = round2(parsed);
    }

    // Atomically lock the ticket BEFORE creating the refund.
    const locked = await Ticket.findOneAndUpdate(
      { _id: ticket._id, status: 'active', refunded: false },
      { $set: { status: 'refund_pending' } },
      { returnDocument: 'after' }
    );

    if (!locked) {
      throw new AppError('A refund request for this ticket is already pending', 409);
    }

    // --- Persist refund ---
    const refund = new Refund({
      ticketId: ticket._id,
      userId,
      eventId: event._id,
      amount,
      reason: reason.trim(),
      isPartial: !!isPartial,
      originalPrice: round2(ticket.price),
      originalAmountPaid: fullAmount,
      status: 'pending',
      source: 'buyer_request',
    });

    try {
      await refund.save();
    } catch (err) {
      await Ticket.updateOne(
        { _id: ticket._id, status: 'refund_pending' },
        { $set: { status: 'active' } }
      );
      throw err;
    }

    locked.refundId = refund._id;
    await locked.save();

    // --- Notify organizer (best-effort) ---
    const organizer = await User.findById(event.organizerId).select('email').lean();
    if (organizer?.email) {
      const subject = sanitizeHeader(`Refund request for ${event.title}`);
      const html = `
        <p>${escapeHtml(ticket.userEmail)} requested a refund of ₵${amount.toFixed(2)} for ticket ${escapeHtml(ticket.id)}.</p>
        <p><strong>Reason:</strong> ${escapeHtml(reason)}</p>
        <p>Please approve or reject in the admin panel.</p>
      `;
      sendEmail(organizer.email, subject, html).catch((err) =>
        logger.error('Refund organizer email failed', {
          refundId: refund._id.toString(),
          err: err.message,
        })
      );
    }

    if (ticket.userEmail) {
      const customerHtml = `
        <h2>Refund request received</h2>
        <p>We've received your refund request for <strong>${escapeHtml(event.title)}</strong>.</p>
        <p><strong>Amount:</strong> ₵${amount.toFixed(2)}</p>
        <p><strong>Reason:</strong> ${escapeHtml(reason)}</p>
        <p>You'll hear from us once the organizer reviews it.</p>
      `;
      sendEmail(ticket.userEmail, 'Refund request received – Glycr', customerHtml).catch((err) =>
        logger.error('Refund received email failed', {
          refundId: refund._id.toString(),
          err: err.message,
        })
      );
    }

    return refund;
  }

  // Authority: admin can approve any refund; organizer only refunds for
  // their own events. actingUser = { id, isAdmin } from the JWT.
  async approveRefund(refundId, actingUser) {
    // 1. Read the refund (before mutation)
    const pre = await Refund.findById(refundId).populate('ticketId').populate('eventId');
    if (!pre) throw new AppError('Refund not found', 404);

    // 2. Authority check — must happen BEFORE any mutation
    if (!actingUser?.id) throw new AppError('Authentication required', 401);
    if (!actingUser.isAdmin) {
      const organizerId = pre.eventId?.organizerId;
      if (!organizerId || String(organizerId) !== String(actingUser.id)) {
        throw new AppError('Forbidden', 403);
      }
    }

    // 3. Status + ticket eligibility
    if (pre.status !== 'pending') throw new AppError('Refund already processed', 409);

    const preTicket = pre.ticketId;
    if (!preTicket) throw new AppError('Linked ticket no longer exists', 500);
    if (preTicket.status !== 'active' && preTicket.status !== 'refund_pending') {
      throw new AppError('Ticket not eligible for refund', 400);
    }

    // 4. Atomic transition
    const refund = await Refund.findOneAndUpdate(
      { _id: refundId, status: 'pending' },
      {
        $set: {
          status: 'approved',
          processedAt: new Date(),
          processedBy: actingUser.id,
        },
      },
      { returnDocument: 'after' }
    ).populate('ticketId').populate('eventId');

    if (!refund) throw new AppError('Refund already processed', 409);

    const ticket = refund.ticketId;
    if (!ticket) throw new AppError('Linked ticket no longer exists', 500);

    // --- Refund the ticket ---
    ticket.status = 'refunded';
    ticket.refunded = true;
    ticket.refundId = refund._id;
    if ('refundedAt' in ticket.schema.paths) ticket.refundedAt = new Date();
    await ticket.save();

    // --- Restore event capacity ---
    const event = refund.eventId;
    if (event) {
      const typeData = event.ticketTypes?.get?.(ticket.ticketType);
      if (typeData && typeData.sold > 0) {
        typeData.sold -= 1;
        event.markModified('ticketTypes');
        await event.save();
      }
    }

    // --- Payment reversal hook ---
    // ⚠️ Placeholder. When you wire in Stripe/Paystack, replace this with a
    //    real refund call using refund._id as the idempotency key.
    logger.info('Refund approved — payment reversal pending', {
      refundId: refund._id.toString(),
      amount: refund.amount,
      ticketId: ticket.id,
      eventId: event?._id?.toString(),
    });

    // --- Notify customer (best-effort) ---
    this._notifyCustomerApproved(refund, ticket, event).catch((err) =>
      logger.error('Refund approval notify failed', {
        refundId: refund._id.toString(),
        err: err.message,
      })
    );

    return refund;
  }

  // Authority: admin can reject any refund; organizer only refunds for
  // their own events. actingUser = { id, isAdmin } from the JWT.
  async rejectRefund(refundId, actingUser, rejectionReason) {
    if (!rejectionReason || typeof rejectionReason !== 'string' || !rejectionReason.trim()) {
      throw new AppError('Rejection reason is required', 400);
    }

    // 1. Read the refund (before mutation)
    const pre = await Refund.findById(refundId).populate('ticketId').populate('eventId');
    if (!pre) throw new AppError('Refund not found', 404);

    // 2. Authority check
    if (!actingUser?.id) throw new AppError('Authentication required', 401);
    if (!actingUser.isAdmin) {
      const organizerId = pre.eventId?.organizerId;
      if (!organizerId || String(organizerId) !== String(actingUser.id)) {
        throw new AppError('Forbidden', 403);
      }
    }

    // 3. Status
    if (pre.status !== 'pending') throw new AppError('Refund already processed', 409);

    // 4. Atomic transition
    const refund = await Refund.findOneAndUpdate(
      { _id: refundId, status: 'pending' },
      {
        $set: {
          status: 'rejected',
          processedAt: new Date(),
          processedBy: actingUser.id,
          rejectionReason: rejectionReason.trim(),
        },
      },
      { returnDocument: 'after' }
    ).populate('ticketId').populate('eventId');

    if (!refund) throw new AppError('Refund already processed', 409);

    // --- Un-lock the ticket ---
    const ticket = refund.ticketId;
    if (ticket && ticket.status === 'refund_pending') {
      ticket.status = 'active';
      ticket.refunded = false;
      ticket.refundId = null;
      if ('refundedAt' in ticket.schema.paths) ticket.refundedAt = null;
      await ticket.save();
    }

    this._notifyCustomerRejected(refund, rejectionReason).catch((err) =>
      logger.error('Refund rejection notify failed', {
        refundId: refund._id.toString(),
        err: err.message,
      })
    );

    return refund;
  }

  // ── Event cancelled: refund every unused ticket in full, automatically ──
  // Called by eventService.cancelEvent. The buyer does not ask and the
  // organizer does not approve their own cancellation.
  //  - Free tickets: nothing to refund, they are simply voided.
  //  - Buyers who already filed a request: it is settled in full instead of
  //    creating a duplicate.
  //  - Everyone else: a new refund, already approved.
  // Tickets end up `cancelled` and linked to their refund. Event capacity is
  // not restored (the event is cancelled). The buyer is told by the
  // cancellation email, so no separate "refund approved" message is sent.
  // Idempotent: safe to run again if a previous run failed halfway.
  async refundCancelledEvent(event, actorId = null) {
    if (!event?._id) throw new AppError('event is required', 400);

    const tickets = await Ticket.find({
      eventId: event._id,
      status: { $in: ['active', 'refund_pending'] },
    })
      // amountPaid is what the buyer paid; price is the fallback for legacy
      // tickets that never recorded amountPaid.
      .select('_id userId price amountPaid')
      .lean();

    if (!tickets.length) return { created: 0, promoted: 0, free: 0, total: 0 };

    const paid = tickets.filter((t) => buyerPaid(t) > 0);
    const free = tickets.filter((t) => buyerPaid(t) <= 0);

    if (free.length) {
      await Ticket.updateMany(
        { _id: { $in: free.map((t) => t._id) } },
        { $set: { status: 'cancelled' } }
      );
    }
    if (!paid.length) return { created: 0, promoted: 0, free: free.length, total: 0 };

    const ids = paid.map((t) => t._id);
    const now = new Date();

    // Tickets that already have a live refund (the buyer asked earlier)
    const existing = await Refund.find({
      ticketId: { $in: ids },
      status: { $in: ['pending', 'approved'] },
    }).select('ticketId status amount originalPrice originalAmountPaid reason').lean();
    const covered = new Set(existing.map((r) => String(r.ticketId)));

    // 1) Pending requests: the cancellation settles them in full
    const pending = existing.filter((r) => r.status === 'pending');
    if (pending.length) {
      await Refund.bulkWrite(pending.map((r) => {
        // The refund was created against ticket.amountPaid or ticket.price
        // depending on when it was filed. Use the ticket's live buyerPaid
        // figure as the settlement amount so the buyer gets everything.
        const t = paid.find((pt) => String(pt._id) === String(r.ticketId));
        const settled = t ? buyerPaid(t) : (r.originalAmountPaid ?? r.originalPrice ?? r.amount);
        return {
          updateOne: {
            filter: { _id: r._id, status: 'pending' },
            update: { $set: {
                status: 'approved',
                isPartial: false,
                amount: settled,
                reason: `${r.reason || 'Refund request'} (settled in full: event cancelled)`,
                processedAt: now,
                processedBy: actorId,
              } },
          },
        };
      }));
    }

    // 2) Everyone else gets a new, already-approved refund
    const docs = paid
      .filter((t) => !covered.has(String(t._id)))
      .map((t) => ({
        ticketId: t._id,
        userId: t.userId,
        eventId: event._id,
        amount: buyerPaid(t),                 // face price + buyer-paid processing fee
        originalPrice: round2(t.price),
        originalAmountPaid: buyerPaid(t),
        isPartial: false,
        reason: 'Event cancelled by organizer',
        status: 'approved',
        source: 'event_cancelled',
        requestedAt: now,
        processedAt: now,
        processedBy: actorId,
      }));
    const created = docs.length ? await Refund.insertMany(docs) : [];

    // 3) Tickets show "cancelled" and point at their refund
    if (created.length) {
      await Ticket.bulkWrite(created.map((r) => ({
        updateOne: {
          filter: { _id: r.ticketId },
          update: { $set: { status: 'cancelled', refundId: r._id } },
        },
      })));
    }
    const coveredIds = paid.filter((t) => covered.has(String(t._id))).map((t) => t._id);
    if (coveredIds.length) {
      await Ticket.updateMany({ _id: { $in: coveredIds } }, { $set: { status: 'cancelled' } });
    }

    const total = round2(paid.reduce((sum, t) => sum + buyerPaid(t), 0));

    // ⚠️ Same placeholder as approveRefund: no payment is moved yet. When a
    //    gateway is wired in, loop over the refunds here and use refund._id
    //    as the idempotency key. Until then an admin marks each refund paid
    //    with completeRefund().
    logger.info('Event-cancellation refunds approved — payment reversal pending', {
      eventId: event._id.toString(),
      refunds: created.length + pending.length,
      totalAmount: total,
    });

    return { created: created.length, promoted: pending.length, free: free.length, total };
  }

  // Admin only: mark an approved refund as paid out (e.g. after a manual MoMo
  // transfer). This is what moves a refund from `approved` to `completed`.
  async completeRefund(refundId, actingUser, paymentReference = null) {
    if (!actingUser?.id) throw new AppError('Authentication required', 401);
    if (!actingUser.isAdmin) throw new AppError('Forbidden', 403);
    if (!isObjectIdString(refundId)) throw new AppError('Invalid refund', 400);

    let reference = null;
    if (paymentReference !== null && paymentReference !== undefined && paymentReference !== '') {
      if (typeof paymentReference !== 'string' || paymentReference.trim().length > 100) {
        throw new AppError('paymentReference must be text of 100 characters or fewer', 400);
      }
      reference = paymentReference.trim();
    }

    const existing = await Refund.findById(refundId).select('status').lean();
    if (!existing) throw new AppError('Refund not found', 404);
    if (existing.status !== 'approved') {
      throw new AppError('Only approved refunds can be marked as paid', 409);
    }

    const refund = await Refund.findOneAndUpdate(
      { _id: refundId, status: 'approved' },
      { $set: { status: 'completed', completedAt: new Date(), paymentReference: reference } },
      { returnDocument: 'after' }
    );
    if (!refund) throw new AppError('Refund was already processed', 409);
    return refund;
  }

  // --- Private notification helpers (fire-and-forget) ---
  async _notifyCustomerApproved(refund, ticket, event) {
    let email = null;
    let phone = null;

    if (refund.userId) {
      const user = await User.findById(refund.userId).select('email phone').lean();
      email = user?.email || null;
      phone = user?.phone || null;
    }
    email = email || ticket?.userEmail || null;
    phone = phone || ticket?.userPhone || null;

    const eventTitle = event?.title || 'your event';

    if (email) {
      const html = `
        <h2>Your refund of ₵${Number(refund.amount).toFixed(2)} for ${escapeHtml(eventTitle)} has been approved.</h2>
        <p>Funds will be returned to your original payment method within 5–7 business days.</p>
      `;
      sendEmail(email, 'Refund approved – Glycr', html).catch((e) =>
        logger.error('refund approval email failed', {
          refundId: refund._id.toString(),
          err: e.message,
        })
      );
    }
    if (phone) {
      const sms = `Glycr: Refund of ₵${Number(refund.amount).toFixed(2)} approved for ${eventTitle}.`;
      sendSMS(phone, sms).catch((e) =>
        logger.error('refund approval SMS failed', {
          refundId: refund._id.toString(),
          err: e.message,
        })
      );
    }
  }

  async _notifyCustomerRejected(refund, rejectionReason) {
    let email = null;
    if (refund.userId) {
      const user = await User.findById(refund.userId).select('email').lean();
      email = user?.email || null;
    }
    if (!email) email = refund.ticketId?.userEmail || null;
    if (!email) return;

    const eventTitle = refund.eventId?.title || 'your event';
    const html = `
      <h2>Your refund request for ${escapeHtml(eventTitle)} has been rejected.</h2>
      <p><strong>Reason:</strong> ${escapeHtml(rejectionReason)}</p>
      <p>Please contact support if you have questions.</p>
    `;
    sendEmail(email, 'Refund request rejected – Glycr', html).catch((e) =>
      logger.error('refund rejection email failed', {
        refundId: refund._id.toString(),
        err: e.message,
      })
    );
  }

  async getUserRefunds(userId) {
    if (!userId) throw new AppError('userId is required', 400);
    return Refund.find({ userId })
      .populate('eventId', 'title date')
      .sort('-requestedAt');
  }

  async getOrganizerRefunds(organizerId) {
    if (!organizerId) throw new AppError('organizerId is required', 400);
    const events = await Event.find({ organizerId }).select('_id').lean();
    const eventIds = events.map((e) => e._id);
    return Refund.find({ eventId: { $in: eventIds } })
      .populate('userId', 'name email')
      .populate('ticketId')
      .sort('-requestedAt');
  }

  async getAllRefunds() {
    return Refund.find()
      .populate('userId', 'name email')
      .populate('eventId', 'title')
      .populate('ticketId')
      .sort('-requestedAt');
  }
}

module.exports = new RefundService();
