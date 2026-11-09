const User = require('../models/User');
const Event = require('../models/Event');
const Ticket = require('../models/Ticket');
const Payout = require('../models/Payout');
const Refund = require('../models/Refund');
const Waitlist = require('../models/Waitlist');
const Favorite = require('../models/Favorite');
const Coupon = require('../models/Coupon');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { sendEmail, sendSMS } = require('./notificationService');
const { AppError } = require('../utils/appError');
const { logger } = require('../config/logger');
const { escapeHtml, sanitizeHtml } = require('../utils/htmlSecurity');
const eventService = require('../services/eventService');
const payoutService = require('./payoutService');
const userService = require('./userService');
const settingsService = require('./settingsService');

class AdminService {
  // ---------- Dashboard ----------
  async getStats() {
    const [allUsers, allEvents, allTickets, allPayouts] = await Promise.all([
      User.find(),
      Event.find(),
      Ticket.find(),
      Payout.find(),
    ]);

    const totalRevenue = allTickets
      .filter((t) => t.status === 'active' || t.status === 'used')
      .reduce((sum, t) => sum + t.price, 0);

    const liveEvents = allEvents.filter(
      (e) => e.isPublished && !e.isCancelled && new Date(e.date) > new Date()
    ).length;
    const flaggedEvents = allEvents.filter((e) => e.flagged).length;
    const pendingPayouts = allPayouts
      .filter((p) => p.status === 'pending')
      .reduce((sum, p) => sum + p.amount, 0);
    const totalOrganizers = allUsers.filter((u) => u.role === 'organizer').length;

    return {
      totalUsers: allUsers.length,
      totalOrganizers,
      totalEvents: allEvents.length,
      liveEvents,
      totalRevenue,
      pendingPayouts,
      totalTickets: allTickets.length,
      flaggedEvents,
    };
  }

  // ---------- Users ----------
  async getAllUsers() {
    const users = await User.find().select('-password');
    return users.map((u) => u.toObject({ virtuals: true }));
  }

  async suspendUser(adminUserId, targetUserId) {
    const admin = await User.findById(adminUserId);
    if (!admin) throw new AppError('Requesting admin not found', 404);

    const target = await User.findById(targetUserId);
    if (!target) throw new AppError('User not found', 404);

    if (admin.role === 'moderator' && (target.role === 'admin' || target.role === 'moderator')) {
      throw new AppError('Moderators cannot suspend admin or moderator accounts', 403);
    }

    target.suspended = !target.suspended;
    await target.save();
    const { password: _pw, ...safeUser } = target.toObject({ virtuals: true });
    return safeUser;
  }

  // Delegates the cascade to userService.deleteUser after permission check.
  async deleteUser(adminUserId, targetUserId) {
    const admin = await User.findById(adminUserId);
    if (!admin) throw new AppError('Requesting admin not found', 404);

    const target = await User.findById(targetUserId);
    if (!target) throw new AppError('User not found', 404);

    if (admin.role === 'moderator' && (target.role === 'admin' || target.role === 'moderator')) {
      throw new AppError('Moderators cannot delete admin or moderator accounts', 403);
    }

    return userService.deleteUser(targetUserId);
  }

  async createUser(userData) {
    const { name, email, password, phone, role, username } = userData;

    if (!name || !email || !password) {
      throw new AppError('Name, email, and password are required', 400);
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    const existingEmail = await User.findOne({ email: normalizedEmail });
    if (existingEmail) throw new AppError('User already exists', 409);

    const normalizedUsername = username ? String(username).toLowerCase().trim() : null;
    if (normalizedUsername) {
      const existingUsername = await User.findOne({ username: normalizedUsername });
      if (existingUsername) throw new AppError('Username already taken', 409);
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      name,
      email: normalizedEmail,
      username: normalizedUsername || undefined,
      password: hashedPassword,
      phone: phone || '',
      role: role || 'customer',
      isOrganizer: role === 'organizer',
      isAdmin: role === 'admin',
      suspended: false,
      currency: 'GHC',
    });

    try {
      await newUser.save();
    } catch (err) {
      if (err.code === 11000) {
        if (err.keyPattern?.email)    throw new AppError('User already exists', 409);
        if (err.keyPattern?.username) throw new AppError('Username already taken', 409);
        throw new AppError('User already exists', 409);
      }
      throw err;
    }

    const { password: _pw, ...userWithoutPassword } = newUser.toObject({ virtuals: true });
    return userWithoutPassword;
  }

  async updateUser(userId, updateData, requestingUserRole) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    if (updateData.role && updateData.role !== user.role && requestingUserRole !== 'admin') {
      throw new AppError('Only admins can change user roles', 403);
    }

    if (updateData.name) user.name = updateData.name;
    if (updateData.email) user.email = String(updateData.email).toLowerCase().trim();
    if (updateData.phone) user.phone = updateData.phone;

    if (updateData.username !== undefined) {
      const normalizedUsername = updateData.username
        ? String(updateData.username).toLowerCase().trim()
        : null;

      if (normalizedUsername && normalizedUsername !== user.username) {
        const existingUsername = await User.findOne({
          username: normalizedUsername,
          _id: { $ne: user._id },
        });
        if (existingUsername) throw new AppError('Username already taken', 409);
      }
      user.username = normalizedUsername || null;
    }

    if (updateData.role) {
      user.role = updateData.role;
      user.isOrganizer = updateData.role === 'organizer';
      user.isAdmin = updateData.role === 'admin';
    }
    if (updateData.suspended !== undefined) {
      user.suspended = updateData.suspended === 'true' || updateData.suspended === true;
    }

    try {
      await user.save();
    } catch (err) {
      if (err.code === 11000) {
        if (err.keyPattern?.email)    throw new AppError('Email already in use', 409);
        if (err.keyPattern?.username) throw new AppError('Username already taken', 409);
        throw new AppError('Duplicate value', 409);
      }
      throw err;
    }

    const { password: _pw, ...userWithoutPassword } = user.toObject({ virtuals: true });
    return userWithoutPassword;
  }

  // Dedicated role-change operation. Looks up the calling admin's role
  // internally so the controller doesn't have to pass it. Delegates the
  // actual permission check to updateUser.
  async changeUserRole(adminUserId, targetUserId, newRole) {
    const admin = await User.findById(adminUserId).select('role').lean();
    if (!admin) throw new AppError('Requesting admin not found', 404);

    return this.updateUser(targetUserId, { role: newRole }, admin.role);
  }

  // ---------- Events ----------
  async getAllEvents() {
    const events = await Event.find().populate('organizerId', '-password');
    return events.map((e) => e.toObject({ virtuals: true }));
  }

  async flagEvent(eventId) {
    const event = await Event.findById(eventId);
    if (!event) throw new AppError('Event not found', 404);
    event.flagged = !event.flagged;
    await event.save();
    return event;
  }

  async unflagEvent(eventId) {
    const event = await Event.findById(eventId);
    if (!event) throw new AppError('Event not found', 404);
    event.flagged = false;
    await event.save();
    return event;
  }

  async deleteEvent(eventId) {
    const event = await Event.findByIdAndDelete(eventId);
    if (!event) throw new AppError('Event not found', 404);

    const unresolvedRefunds = await Refund.countDocuments({
      eventId,
      status: { $in: ['pending', 'approved'] },
    });
    if (unresolvedRefunds > 0) {
      logger.warn('Admin force-deleted event with unresolved refunds', {
        eventId: eventId.toString(),
        title: event.title,
        unresolvedRefunds,
      });
    }

    await Ticket.deleteMany({ eventId });
    await Favorite.deleteMany({ eventId });
    await Waitlist.deleteMany({ eventId });
    await Refund.deleteMany({ eventId });
    return true;
  }

  // Admin-only publish toggle — no ownership check (any admin can act on any event).
  async togglePublish(eventId) {
    const event = await Event.findById(eventId);
    if (!event) throw new AppError('Event not found', 404);
    event.isPublished = !event.isPublished;
    await event.save();
    return event;
  }

  async cancelEvent(adminId, eventId) {
    return eventService.cancelEvent(eventId, adminId, true);
  }

  async restoreEvent(adminId, eventId) {
    return eventService.restoreEvent(eventId);
  }

  // ---------- Tickets ----------
  async getAllTickets() {
    return Ticket.find().populate('eventId', 'title').populate('userId', 'name email');
  }

  // ---------- Payouts ----------
  // Delegated to payoutService so the safety guards apply here too.
  async getAllPayouts() {
    return payoutService.getAllPayouts();
  }

  async approvePayout(payoutId, processedById) {
    return payoutService.approvePayout(payoutId, processedById);
  }

  async rejectPayout(payoutId, reason, processedById = null) {
    return payoutService.rejectPayout(payoutId, reason, processedById);
  }

  async completePayout(adminId, payoutId, paymentReference) {
    return payoutService.completePayout(payoutId, adminId, paymentReference);
  }

  // ---------- Coupons ----------
  // Admin view: all coupons from all organizers.
  async getAllCoupons() {
    return Coupon.find().populate('organizerId', 'name email').sort('-createdAt');
  }

  // ---------- Waitlist Management ----------
  async getAllWaitlists() {
    const entries = await Waitlist.find()
      .populate('eventId', 'title date')
      .sort({ joinedAt: -1 })
      .lean();

    return entries
      .filter((entry) => entry.eventId != null)
      .map((entry) => ({
        id: entry._id.toString(),
        userId: null,
        userName: entry.name,
        userEmail: entry.email,
        userPhone: entry.phone,
        eventId: entry.eventId._id.toString(),
        eventTitle: entry.eventId.title,
        eventDate: entry.eventId.date,
        ticketType: entry.ticketType,
        position: entry.position,
        joinedAt: entry.joinedAt,
        notified: entry.notified,
      }));
  }

  async notifyWaitlistEntry(entryId, channel, message) {
    const entry = await Waitlist.findById(entryId).populate('eventId');
    if (!entry) throw new AppError('Waitlist entry not found', 404);

    const safeMessageForEmail = escapeHtml(message);
    const safeMessageForSms = sanitizeHtml(message);

    if (channel === 'email' || channel === 'both') {
      await sendEmail(entry.email, 'Waitlist update', safeMessageForEmail);
    }
    if (channel === 'sms' || channel === 'both') {
      await sendSMS(entry.phone, safeMessageForSms);
    }
    entry.notified = true;
    await entry.save();
    return { success: true };
  }

  // Convert a waitlist entry into a PAID ticket.
  //
  // Payment is collected out of band (MoMo / bank / gateway) before this is
  // called, so the caller must supply:
  //   paymentReference → the gateway transaction ID / MoMo receipt / bank ref
  //   paymentGateway   → one of the Ticket model's enum values
  // Optional:
  //   amountPaid → what the buyer actually paid. Defaults to the calculated
  //                buyer total (price + processingFee). Override only when the
  //                collected amount differs (e.g. cash round-up).
  //   paidAt     → when the money actually landed. Defaults to now. Recorded
  //                as Ticket.purchasedAt so sales-trend reports match reality.
  //
  // Fee fields (platformFee / processingFee) are frozen at current rates and
  // written onto the ticket exactly like ticketService.purchaseTicket, so
  // downstream services (revenue, refunds, payout, analytics) see a normal
  // paid ticket — no legacy fallback.
  //
  // Idempotency: rejects if the customer already has an active/used ticket
  // for this event + type, so a retry after a partial failure does not
  // create a duplicate sale. The waitlist entry is deleted as the last step,
  // so a partial failure leaves it intact for the admin to retry.
  async convertWaitlistToTicket(entryId, ticketType, paymentInfo = {}) {
    const { paymentReference, paymentGateway, amountPaid, paidAt } = paymentInfo;

    // ── Validate payment info ──
    if (!paymentReference || typeof paymentReference !== 'string' || !paymentReference.trim()) {
      throw new AppError(
        'paymentReference is required — record the gateway transaction ID, MoMo receipt, or bank reference',
        400
      );
    }
    const ALLOWED_GATEWAYS = ['stripe', 'paystack', 'paypal', 'manual'];
    if (!paymentGateway || !ALLOWED_GATEWAYS.includes(paymentGateway)) {
      throw new AppError(
        `paymentGateway is required and must be one of: ${ALLOWED_GATEWAYS.join(', ')}`,
        400
      );
    }

    // ── Load waitlist entry ──
    const entry = await Waitlist.findById(entryId).populate('eventId');
    if (!entry) throw new AppError('Waitlist entry not found', 404);

    const event = entry.eventId;
    if (!event) throw new AppError('Event no longer exists', 404);
    if (event.isCancelled) {
      throw new AppError('Event has been cancelled — refund the payment instead', 400);
    }
    if (event.isPublished === false) {
      throw new AppError('Event is not published — publish it before converting', 400);
    }

    // ── Validate ticket type ──
    const ticketTypes = event.ticketTypes;
    if (!ticketTypes || !(ticketTypes instanceof Map)) {
      throw new AppError('Event ticket types are corrupted', 500);
    }
    if (typeof ticketType !== 'string' || !ticketType.trim()) {
      throw new AppError('Ticket type is required', 400);
    }

    const normalizedType = ticketType.trim().toLowerCase();
    let matchedKey = null;
    for (const [key] of ticketTypes.entries()) {
      if (key.toLowerCase() === normalizedType) { matchedKey = key; break; }
    }
    if (!matchedKey) {
      const available = Array.from(ticketTypes.keys()).join(', ');
      throw new AppError(
        `Invalid ticket type. Received: "${ticketType}". Available: ${available}`,
        400
      );
    }

    const typeData = ticketTypes.get(matchedKey);
    if (typeData.sold >= typeData.capacity) {
      throw new AppError('Tickets sold out — refund the payment instead', 409);
    }

    // ── Idempotency: has this customer already been converted? ──
    // Checks by email + event + type, so a retry after a partial failure
    // (ticket created, waitlist delete failed) doesn't create a second
    // ticket. If the ticket exists, we just clean up the waitlist entry and
    // return it — the admin's retry converges to the correct state.
    const alreadyPurchased = await Ticket.findOne({
      eventId: event._id,
      ticketType: matchedKey,
      userEmail: String(entry.email).toLowerCase().trim(),
      status: { $in: ['active', 'used'] },
    }).select('id').lean();
    if (alreadyPurchased) {
      await Waitlist.findByIdAndDelete(entryId);
      return {
        success: true,
        alreadyConverted: true,
        ticket: { id: alreadyPurchased.id, ticketType: matchedKey },
      };
    }

    // ── Resolve / create user ──
    let user = await User.findOne({ email: entry.email });
    if (!user) {
      user = new User({
        name: entry.name,
        email: entry.email,
        phone: entry.phone,
        password: await bcrypt.hash(Math.random().toString(36), 10),
        role: 'customer',
      });
      await user.save();
    }

    // ── Fees: frozen at current rates, same as ticketService.purchaseTicket ──
    const money = await settingsService.quoteOrder(typeData.price, event);

    // What the buyer actually paid. Default to the calculated buyer total;
    // override only if the collected amount differs.
    const actualAmountPaid =
      amountPaid != null && amountPaid !== ''
        ? Math.round(Number(amountPaid) * 100) / 100
        : money.buyerTotal;
    if (!Number.isFinite(actualAmountPaid) || actualAmountPaid < 0) {
      throw new AppError('amountPaid must be a non-negative number', 400);
    }

    // When the money landed. Defaults to now, recorded as purchasedAt so
    // reports use the payment date, not the conversion date.
    const purchasedAt = paidAt ? new Date(paidAt) : new Date();
    if (isNaN(purchasedAt)) throw new AppError('paidAt must be a valid date', 400);

    // ── Create the ticket ──
    const ticketId = uuidv4();
    const ticket = new Ticket({
      id: ticketId,
      eventId: event._id,
      userId: user._id,
      ticketType: matchedKey,

      // Money (frozen at conversion time)
      price: typeData.price,
      platformFee: money.platformFee,        // organizer-paid
      processingFee: money.processingFee,    // buyer-paid
      feePaidBy: 'organizer',                // legacy marker for new tickets
      amountPaid: actualAmountPaid,

      // Payment traceability
      paymentIntentId: paymentReference.trim(),
      paymentGateway,

      userEmail: String(entry.email).toLowerCase().trim(),
      userPhone: entry.phone,
      purchasedAt,
      status: 'active',
      validated: false,
    });
    await ticket.save();

    // ── Reserve capacity ──
    typeData.sold += 1;
    event.markModified('ticketTypes');
    try {
      await event.save();
    } catch (err) {
      // Roll back the ticket so the admin can retry cleanly.
      await Ticket.deleteOne({ _id: ticket._id })
        .catch((e) => logger.error('convertWaitlist rollback failed', { err: e.message }));
      throw err;
    }

    // ── Clean up the waitlist entry (last step, so partial failures retry) ──
    await Waitlist.findByIdAndDelete(entryId);

    sendEmail(entry.email, `Your ticket for ${event.title}`, `<p>Ticket ID: ${ticketId}</p>`)
      .catch((e) => logger.error('waitlist ticket email failed', { err: e.message }));
    sendSMS(entry.phone, `Glycr: Your ${matchedKey} ticket is ready. ID: ${ticketId}`)
      .catch((e) => logger.error('waitlist ticket SMS failed', { err: e.message }));

    return {
      success: true,
      ticket: {
        id: ticket.id,
        ticketType: matchedKey,
        amountPaid: actualAmountPaid,
        paymentReference: paymentReference.trim(),
        paymentGateway,
      },
    };
  }

  async deleteWaitlistEntry(entryId) {
    const result = await Waitlist.findByIdAndDelete(entryId);
    if (!result) throw new AppError('Waitlist entry not found', 404);
    return true;
  }
}

module.exports = new AdminService();
