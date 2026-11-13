// services/eventService.js
const Event = require('../models/Event');
const Ticket = require('../models/Ticket');
const Refund = require('../models/Refund');
const Waitlist = require('../models/Waitlist');
const Favorite = require('../models/Favorite');
const { sendEmail, sendSMS } = require('./notificationService');
const refundService = require('./refundService');
const { AppError } = require('../utils/appError');
const { logger } = require('../config/logger');
const { escapeHtml, sanitizeHtml, sanitizeHeader } = require('../utils/htmlSecurity');

// Fields an organizer is allowed to set when creating/updating their own event.
// Must match models/Event.js exactly — anything not in the schema would be
// silently dropped by Mongoose, and anything missing that's schema-required
// would break save. `image` is handled separately via the imageUrl parameter.
const ORGANIZER_WRITABLE_FIELDS = [
  // Core (required in schema)
  'title', 'description', 'venue', 'date', 'category', 'currency',
  'organizerEmail', 'organizerPhone', 'ticketTypes',
  // Optional
  'location', 'address', 'lat', 'lng', 'publishAt',
  // Per-event override for who pays the platform fee
  'feePaidBy',
];

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
};

class EventService {
  async createEvent(organizerId, eventData, imageUrl = null) {
    if (!organizerId) throw new AppError('organizerId is required', 400);
    if (!eventData || typeof eventData !== 'object') {
      throw new AppError('Invalid event data', 400);
    }
    if (!eventData.title || typeof eventData.title !== 'string') {
      throw new AppError('Event title is required', 400);
    }
    if (!eventData.date || isNaN(new Date(eventData.date))) {
      throw new AppError('Valid event date is required', 400);
    }
    if (new Date(eventData.date) < new Date()) {
      throw new AppError('Event date must be in the future', 400);
    }
    if (!eventData.venue || typeof eventData.venue !== 'string') {
      throw new AppError('Venue is required', 400);
    }
    if (!eventData.currency) throw new AppError('Currency is required', 400);
    if (!eventData.organizerEmail) throw new AppError('Organizer email is required', 400);
    if (!eventData.organizerPhone) throw new AppError('Organizer phone is required', 400);
    if (
      !eventData.ticketTypes ||
      typeof eventData.ticketTypes !== 'object' ||
      Object.keys(eventData.ticketTypes).length === 0
    ) {
      throw new AppError('At least one ticket type is required', 400);
    }

    const clean = pick(eventData, ORGANIZER_WRITABLE_FIELDS);


    if (clean.feePaidBy !== undefined) {
      if (clean.feePaidBy === null || clean.feePaidBy === '') {
        clean.feePaidBy = null;
      } else if (!['organizer', 'buyer'].includes(clean.feePaidBy)) {
        throw new AppError('feePaidBy must be organizer, buyer, or empty', 400);
      }
    }

    // publishAt: if set to a future time, create as draft. The scheduler in
    // services/scheduler.js flips isPublished → true when publishAt arrives.
    let publishAt = null;
    let isPublished = true;
    if (clean.publishAt !== undefined) {
      if (clean.publishAt === null || clean.publishAt === '') {
        clean.publishAt = null;
        // Clearing the schedule: leave isPublished alone. If the event is
        // already live, it stays live. If it's still a draft, the organizer
        // can publish manually via togglePublish. Auto-publishing a draft
        // because the user cleared the schedule would be surprising.
      } else {
        const parsed = new Date(clean.publishAt);
        if (isNaN(parsed)) throw new AppError('Invalid publish date', 400);
        if (parsed > new Date()) {
          // Future schedule → force draft. The cron job publishes it when
          // the time arrives. This also un-publishes a live event if the
          // organizer schedules it, which matches intent.
          clean.publishAt = parsed;
          clean.isPublished = false;
        } else {
          // Past publishAt submitted — treat as "publish now" and drop the
          // dead timestamp so the scheduler never queries it.
          clean.publishAt = null;
          clean.isPublished = true;
        }
      }
    }



    const event = new Event({
      ...clean,
      organizerId,
      image: imageUrl,
      isPublished,
      publishAt,
      isCancelled: false,
      flagged: false,
    });

    await event.save();
    return event;
  }

  async getEventById(id) {
    if (!id) throw new AppError('Event id is required', 400);
    const event = await Event.findById(id).populate('organizerId', '-password');
    if (!event) throw new AppError('Event not found', 404);
    return event;
  }

  async updateEvent(eventId, organizerId, updates, imageUrl = null) {
    if (!organizerId) throw new AppError('organizerId is required', 400);
    if (!updates || typeof updates !== 'object') {
      throw new AppError('Invalid update data', 400);
    }

    const event = await Event.findById(eventId);
    if (!event) throw new AppError('Event not found', 404);
    if (event.organizerId.toString() !== organizerId.toString()) {
      throw new AppError('You do not have permission to update this event', 403);
    }
    if (event.isCancelled) {
      throw new AppError('Cannot update a cancelled event', 400);
    }

    const clean = pick(updates, ORGANIZER_WRITABLE_FIELDS);
    if (imageUrl) clean.image = imageUrl;

    if (clean.title !== undefined && (!clean.title || typeof clean.title !== 'string')) {
      throw new AppError('Event title cannot be empty', 400);
    }
    if (clean.date !== undefined && isNaN(new Date(clean.date))) {
      throw new AppError('Invalid event date', 400);
    }
    if (clean.ticketTypes !== undefined) {
      if (
        typeof clean.ticketTypes !== 'object' ||
        Object.keys(clean.ticketTypes).length === 0
      ) {
        throw new AppError('At least one ticket type is required', 400);
      }
    }

    if (clean.publishAt !== undefined) {
      if (clean.publishAt === null || clean.publishAt === '') {
        clean.publishAt = null;
      } else {
        const parsed = new Date(clean.publishAt);
        if (isNaN(parsed)) throw new AppError('Invalid publish date', 400);
        clean.publishAt = parsed;
      }
    }

    if (clean.feePaidBy !== undefined) {
      if (clean.feePaidBy === null || clean.feePaidBy === '') {
        clean.feePaidBy = null;
      } else if (!['organizer', 'buyer'].includes(clean.feePaidBy)) {
        throw new AppError('feePaidBy must be organizer, buyer, or empty', 400);
      }
    }

    const updated = await Event.findByIdAndUpdate(eventId, clean, {
      returnDocument: 'after',
      runValidators: true,
    });
    return updated;
  }

  async deleteEvent(eventId, organizerId, isAdmin = false) {
    const event = await Event.findById(eventId);
    if (!event) throw new AppError('Event not found', 404);
    if (!isAdmin && event.organizerId.toString() !== organizerId.toString()) {
      throw new AppError('You do not have permission to delete this event', 403);
    }

    // Organizer self-delete: refuse if unresolved refunds exist. Admin
    // force-delete (via adminService.deleteEvent) bypasses this check.
    if (!isAdmin) {
      const unresolvedRefunds = await Refund.countDocuments({
        eventId,
        status: { $in: ['pending', 'approved'] },
      });
      if (unresolvedRefunds > 0) {
        throw new AppError(
          `Cannot delete event — ${unresolvedRefunds} refund(s) are pending or approved. ` +
          `Process all refunds before deleting.`,
          409
        );
      }

      // Sold tickets are financial records. Revenue and the available balance are
      // computed from them, so deleting them would silently change what the
      // organizer can withdraw and wipe the buyers' history.
      const liveSales = await Ticket.countDocuments({
        eventId,
        status: { $in: ['active', 'used', 'refund_pending'] },
      });
      if (liveSales > 0) {
        const upcoming = !event.isCancelled && new Date(event.date) > new Date();
        throw new AppError(
          `Cannot delete event — ${liveSales} ticket${liveSales !== 1 ? 's have' : ' has'} been sold. ` +
          (upcoming
            ? 'Cancel the event to refund buyers automatically, then delete it once the refunds are complete.'
            : 'Events with sales are kept for financial records. You can unpublish it instead.'),
          409
        );
      }
    }

    await event.deleteOne();

    // Cascade cleanup — remove all event-scoped data.
    // ScanLog is append-only audit history and is intentionally kept.
    await Ticket.deleteMany({ eventId });
    await Favorite.deleteMany({ eventId });
    await Waitlist.deleteMany({ eventId });
    await Refund.deleteMany({ eventId });

    return true;
  }

  async togglePublish(eventId, organizerId) {
    const event = await Event.findById(eventId);
    if (!event) throw new AppError('Event not found', 404);
    if (event.organizerId.toString() !== organizerId.toString()) {
      throw new AppError('You do not have permission to publish this event', 403);
    }
    if (event.isCancelled) {
      throw new AppError('Cannot publish a cancelled event', 400);
    }
    event.isPublished = !event.isPublished;
    // Manually publishing a scheduled draft consumes the schedule — drop the
    // stale timestamp so the cron job doesn't leave a phantom publishAt on
    // a live event. Unpublishing keeps publishAt = null (the organizer can
    // re-schedule via the edit form if they want).
    if (event.isPublished) event.publishAt = null;
    await event.save();
    return event;
  }

  async cancelEvent(eventId, requesterId, isAdmin = false) {
    const event = await Event.findById(eventId).populate('organizerId', 'name');
    if (!event) throw new AppError('Event not found', 404);

    const ownerId = event.organizerId?._id || event.organizerId;
    if (!isAdmin && ownerId.toString() !== requesterId.toString()) {
      throw new AppError('You do not have permission to cancel this event', 403);
    }

    if (event.isCancelled) {
      throw new AppError('Event is already cancelled', 400);
    }

    event.isCancelled = true;
    await event.save();

    // Every unused ticket is refunded in full, automatically. The buyer does
    // not have to ask and the organizer does not approve their own
    // cancellation. Tickets end up `cancelled` (so they can't be scanned at
    // the door — staffService.validateTicket has a guard for that) and point
    // at their refund via `refundId`. The refund logic lives in refundService.
    const refundResult = await refundService.refundCancelledEvent(event, requesterId);
    logger.info('Event cancelled - tickets voided and refunds created', {
      eventId: event._id.toString(),
      ...refundResult,
    });

    // Notify the holders whose tickets were just cancelled
    const tickets = await Ticket.find({ eventId, status: 'cancelled' })
      .select('id userEmail userPhone price')
      .lean();

    if (tickets.length === 0) return event;

    // ── Build notification content (safe-string escaped once) ──
    // Every user-controlled field is escaped before interpolation so a
    // malicious event title like `<script>` or `<img src=x onerror=...>`
    // can't inject markup into the cancellation email.
    const organizerName = event.organizerId?.name || 'the organizer';
    const titleEsc      = escapeHtml(event.title);
    const venueEsc      = escapeHtml(event.venue);
    const locationEsc   = escapeHtml(event.location || '');
    const organizerEsc  = escapeHtml(organizerName);
    const dateStr = new Date(event.date).toLocaleString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    // Subject goes into an email header — sanitizeHeader strips CR/LF to
    // prevent header injection, sanitizeHtml strips any markup defensively.
    const subjectSafe = sanitizeHeader(`Event cancelled: ${event.title}`);

    // SMS can't render HTML — strip tags entirely so "&lt;b&gt;" style
    // entities don't appear literally in the SMS. Paid tickets are told about
    // the automatic refund; free tickets have nothing to refund.
    const smsPaid = sanitizeHtml(
      `Glycr: The event "${event.title}" has been cancelled by ${organizerName}. ` +
      `Your ticket is no longer valid. A full refund is being processed automatically (5-7 business days).`
    );
    const smsFree = sanitizeHtml(
      `Glycr: The event "${event.title}" has been cancelled by ${organizerName}. ` +
      `Your ticket is no longer valid.`
    );

    // ── Notify ticket holders (fire-and-forget) ──
    // Matches the pattern in messageService.createBroadcast — per-recipient
    // .catch so one failure doesn't block the rest. For very large events
    // (500+ tickets) consider batching through a job queue to respect
    // provider rate limits; for current scale this is fine.
    let emailAttempts = 0;
    let smsAttempts = 0;

    for (const ticket of tickets) {
      const refundable = Number(ticket.price) > 0;

      if (ticket.userEmail) {
        emailAttempts++;
        const refundLine = refundable
          ? `<p>You don't need to do anything. A full refund of the price you paid is being processed automatically and should reach your original payment method within 5–7 business days.</p>`
          : '';
        const html = `
          <h2>Event cancelled: ${titleEsc}</h2>
          <p>We regret to inform you that <strong>${titleEsc}</strong> has been cancelled by ${organizerEsc}.</p>
          <p><strong>When:</strong> ${dateStr}</p>
          <p><strong>Where:</strong> ${venueEsc}${locationEsc ? `, ${locationEsc}` : ''}</p>
          <p>Your ticket (ID: <code>${escapeHtml(ticket.id)}</code>) is no longer valid for entry.</p>
          ${refundLine}
          <p>– Glycr Team</p>
        `;
        sendEmail(ticket.userEmail, subjectSafe, html)
          .catch((err) => logger.error('Cancellation email failed', {
            eventId: event._id.toString(),
            ticketId: ticket.id,
            err: err.message,
          }));
      }
      if (ticket.userPhone) {
        smsAttempts++;
        sendSMS(ticket.userPhone, refundable ? smsPaid : smsFree)
          .catch((err) => logger.error('Cancellation SMS failed', {
            eventId: event._id.toString(),
            ticketId: ticket.id,
            err: err.message,
          }));
      }
    }

    logger.info('Event cancellation notifications dispatched', {
      eventId: event._id.toString(),
      ticketCount: tickets.length,
      emailAttempts,
      smsAttempts,
    });

    return event;
  }

  async restoreEvent(eventId) {
    const event = await Event.findById(eventId);
    if (!event) throw new AppError('Event not found', 404);
    if (!event.isCancelled) throw new AppError('Event is not cancelled', 400);
    if (new Date(event.date) <= new Date()) {
      throw new AppError('Past events cannot be restored', 400);
    }

    // Once refunds exist the cancellation is final: undoing it would mean
    // reversing real money movements.
    const inProgress = await Refund.countDocuments({
      eventId,
      status: { $in: ['approved', 'completed'] },
    });
    if (inProgress > 0) {
      throw new AppError('This event has refunds in progress and cannot be restored.', 409);
    }

    event.isCancelled = false;
    await event.save();

    // tickets that were voided by the cancellation become scannable again
    await Ticket.updateMany(
      { eventId, status: 'cancelled', refunded: { $ne: true } },
      { $set: { status: 'active' } }
    );
    return event;
  }

  async getEvents(filters = {}) {
    const query = {};
    const now = new Date();

    if (filters.search && typeof filters.search === 'string' && filters.search.trim()) {
      const search = escapeRegex(filters.search.trim());
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }
    if (filters.category) query.category = filters.category;
    if (filters.location) query.location = filters.location;
    if (filters.upcoming) {
      query.date = { $gt: now };
      query.isCancelled = false;
      query.isPublished = true;
    }
    if (filters.organizerId) query.organizerId = filters.organizerId;
    if (filters.flagged) query.flagged = true;

    let q = Event.find(query).populate('organizerId', '-password');

    const limit = Math.min(Number(filters.limit) || 0, 100);
    if (limit > 0) q = q.limit(limit);
    if (filters.skip) q = q.skip(Number(filters.skip) || 0);

    return q;
  }

  async flagEvent(eventId) {
    const event = await Event.findByIdAndUpdate(eventId, { flagged: true }, { returnDocument: 'after' });
    if (!event) throw new AppError('Event not found', 404);
    return event;
  }

  async unflagEvent(eventId) {
    const event = await Event.findByIdAndUpdate(eventId, { flagged: false }, { returnDocument: 'after' });
    if (!event) throw new AppError('Event not found', 404);
    return event;
  }
}

module.exports = new EventService();
