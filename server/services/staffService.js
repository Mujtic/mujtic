// services/staffService.js
const Staff   = require('../models/Staff');
const ScanLog = require('../models/ScanLog');
const Ticket  = require('../models/Ticket');
const Event   = require('../models/Event');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const mongoose = require('mongoose');
const config  = require('../config');
const { AppError } = require('../utils/appError');
const { logger } = require('../config/logger');

// Hard cap on how many active staff we'll bcrypt-compare in pinLogin.
// Prevents O(n) DoS as the staff count grows. Beyond this, the route MUST
// have its own rate limiter — 100 staff × 100ms bcrypt = 10s per attempt.
const MAX_PIN_CANDIDATES = 500;
const PIN_MIN_LEN = 4;
const PIN_MAX_LEN = 12;

// Escape regex metacharacters — user search can't inject patterns or ReDoS
const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class StaffService {
  _genStaffId() {
    return 'S' + crypto.randomBytes(4).toString('hex').toUpperCase();
  }

  _isValidObjectId(id) {
    return mongoose.Types.ObjectId.isValid(id);
  }

  // Build the `{ $or: [{ staffId }, { _id }] }` condition used in every lookup
  _staffLookup(staffIdOrId, organizerId) {
    const conditions = [{ staffId: staffIdOrId }];
    if (this._isValidObjectId(staffIdOrId)) conditions.push({ _id: staffIdOrId });
    return { $or: conditions, organizerId };
  }

  async _getOrganizerEventIds(organizerId) {
    const events = await Event.find({ organizerId }).select('_id').lean();
    return events.map((e) => e._id);
  }

  async _requireOrganizerEvent(eventId, organizerId) {
    if (!eventId) throw new AppError('eventId is required', 400);
    const event = await Event.findOne({ _id: eventId, organizerId });
    // Deliberately 403 (not 404) so we don't leak which events exist for other organizers
    if (!event) throw new AppError('Event not found or not yours', 403);
    return event;
  }

  // ── Create staff member ────────────────────────────────────
  async createStaff(organizerId, data) {
    const { name, email, phone, role, eventId, pin } = data || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new AppError('name is required', 400);
    }
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AppError('A valid email is required', 400);
    }
    if (!eventId) throw new AppError('eventId is required', 400);
    if (role && !['scanner', 'supervisor'].includes(role)) {
      throw new AppError('role must be one of: scanner, supervisor', 400);
    }
    if (pin != null) {
      const pinStr = String(pin);
      if (!/^\d+$/.test(pinStr) || pinStr.length < PIN_MIN_LEN || pinStr.length > PIN_MAX_LEN) {
        throw new AppError(`PIN must be ${PIN_MIN_LEN}-${PIN_MAX_LEN} digits`, 400);
      }
    }

    await this._requireOrganizerEvent(eventId, organizerId);

    // Prevent duplicate email per organizer
    const existing = await Staff.findOne({ organizerId, email: email.toLowerCase().trim() })
      .select('_id').lean();
    if (existing) throw new AppError('A staff member with this email already exists', 409);

    const staffId = this._genStaffId();

    // WARNING: if `pin` is stored plaintext by the model, replace this with
    // a pre-save hook that bcrypt-hashes it before persistence.
    const staff = new Staff({
      staffId,
      name: name.trim(),
      email: email.toLowerCase().trim(),
      phone: phone || null,
      role: role || 'scanner',
      eventId,
      organizerId,
      pin: pin != null ? String(pin) : null,
    });

    try {
      await staff.save();
    } catch (err) {
      if (err.code === 11000) {
        if (err.keyPattern?.email)   throw new AppError('A staff member with this email already exists', 409);
        if (err.keyPattern?.staffId) throw new AppError('Staff ID collision — please retry', 409);
        throw new AppError('Staff member already exists', 409);
      }
      throw err;
    }
    return staff;
  }

  async listStaff(organizerId, eventId = null) {
    const query = { organizerId };
    if (eventId) query.eventId = eventId;
    return Staff.find(query).sort({ createdAt: -1 }).lean();
  }

  async getStaff(staffIdOrId, organizerId) {
    const staff = await Staff.findOne(this._staffLookup(staffIdOrId, organizerId));
    if (!staff) throw new AppError('Staff member not found', 404);
    return staff;
  }

  async setStatus(staffIdOrId, organizerId, status) {
    if (!['active', 'inactive'].includes(status)) {
      throw new AppError('status must be active or inactive', 400);
    }
    const staff = await Staff.findOneAndUpdate(
      this._staffLookup(staffIdOrId, organizerId),
      { status },
      { returnDocument: 'after' }
    );
    if (!staff) throw new AppError('Staff member not found', 404);
    return staff;
  }

  async deleteStaff(staffIdOrId, organizerId) {
    const staff = await Staff.findOne(this._staffLookup(staffIdOrId, organizerId));
    if (!staff) throw new AppError('Staff member not found', 404);
    await staff.deleteOne();
    return true;
  }

  // ── Validate a ticket ──────────────────────────────────────
  // Returns { result, message, ticket?, scanLog? }
  // result: 'valid' | 'already_used' | 'invalid' | 'wrong_event' | 'refunded' | 'cancelled'
  async validateTicket({ ticketId, eventId, organizerId, scannedById, staffId, staffName, method, device, ip }) {
    if (!ticketId) throw new AppError('ticketId is required', 400);
    if (!eventId)  throw new AppError('eventId is required', 400);

    // Verify organizer owns the event BEFORE doing anything else.
    // Without this, organizer A could theoretically scan organizer B's tickets
    // by passing B's eventId (depending on how the route builds `organizerId`).
    const event = await this._requireOrganizerEvent(eventId, organizerId);   // ← capture

    const ticket = await Ticket.findOne({ id: ticketId });

    if (!ticket) {
      await this._log({ ticketId, eventId, organizerId, scannedById, staffId, staffName,
        method, device, ip, result: 'invalid', ticket: null, event });
      return { result: 'invalid', message: 'Ticket not found.' };
    }

    if (String(ticket.eventId) !== String(eventId)) {
      await this._log({ ticketId, eventId, organizerId, scannedById, staffId, staffName,
        method, device, ip, result: 'wrong_event', ticket, event });
      return { result: 'wrong_event', message: 'This ticket is for a different event.' };
    }

    // Refunded / refund_pending tickets must NOT be validated
    if (ticket.status === 'refunded' || ticket.refunded) {
      await this._log({ ticketId, eventId, organizerId, scannedById, staffId, staffName,
        method, device, ip, result: 'refunded', ticket, event });
      return { result: 'refunded', message: 'This ticket has been refunded and is no longer valid.' };
    }
    if (ticket.status === 'refund_pending') {
      await this._log({ ticketId, eventId, organizerId, scannedById, staffId, staffName,
        method, device, ip, result: 'refund_pending', ticket, event });
      return { result: 'refund_pending', message: 'This ticket has a pending refund and cannot be used.' };
    }
    if (ticket.status === 'cancelled') {
      await this._log({ ticketId, eventId, organizerId, scannedById, staffId, staffName,
        method, device, ip, result: 'cancelled', ticket, event });
      return { result: 'cancelled', message: 'This ticket has been cancelled.' };
    }

    // ── Atomic check-in (prevents double-scan race) ──
    // Two scanners hitting the same ticket at once: exactly one wins.
    const updated = await Ticket.findOneAndUpdate(
      { _id: ticket._id, status: 'active', validated: false },
      { $set: { status: 'used', validated: true, validatedAt: new Date() } },
      { returnDocument: 'after' }
    );

    if (!updated) {
      // Someone else validated between our read and our update
      await this._log({ ticketId, eventId, organizerId, scannedById, staffId, staffName,
        method, device, ip, result: 'already_used', ticket, event });
      return { result: 'already_used', message: 'This ticket has already been used.', ticket };
    }

    const log = await this._log({ ticketId, eventId, organizerId, scannedById, staffId, staffName,
      method, device, ip, result: 'valid', ticket: updated, event });

    return { result: 'valid', message: 'Ticket validated successfully.', ticket: updated, scanLog: log };
  }

  async _log({ ticketId, eventId, organizerId, scannedById, staffId, staffName, method, device, ip, result, ticket, event }) {
    try {
      const ticketRef = ticket?._id || (await Ticket.findOne({ id: ticketId })?.select('_id').lean())?._id;
      if (!ticketRef) return null;

      const log = new ScanLog({
        ticketId,
        ticketRef,
        eventId,
        organizerId,
        scannedById:   scannedById || null,
        staffId:       staffId     || null,
        scannedByName: staffName   || 'organizer',
        method:        method      || 'manual',
        eventTitle:    event?.title || null,      // ← was: ev?.title || null  (now correct)
        result,
        device:        device      || null,
        ipAddress:     ip          || null,
        buyerName:     ticket?.buyerName  || null,
        buyerEmail:    ticket?.userEmail  || null,
        ticketType:    ticket?.ticketType || null,
      });
      await log.save();
      return log;
    } catch (err) {
      // Non-fatal — the check-in already succeeded
      logger.warn('ScanLog write failed (non-fatal)', {
        ticketId, eventId: eventId?.toString(), err: err.message,
      });
      return null;
    }
  }

  async getScanLogs({ organizerId, eventId, limit = 100, staffFilter }) {
    if (eventId) await this._requireOrganizerEvent(eventId, organizerId);

    const query = { organizerId };
    if (eventId) query.eventId = eventId;
    if (staffFilter === 'organizer') query.staffId = null;
    else if (staffFilter)            query.scannedByName = staffFilter;

    // Clamp limit — NaN from a bad query string would otherwise crash .limit()
    const limitNum = Math.min(Math.max(Number(limit) || 100, 1), 500);

    const logs = await ScanLog.find(query)
      .sort({ scannedAt: -1 })
      .limit(limitNum)
      .lean();

    return logs.map((l) => ({
      id:          l._id.toString(),
      ticketId:    l.ticketId,
      eventId:     l.eventId?.toString(),
      eventTitle:  l.eventTitle || null,
      buyerName:   l.buyerName,
      buyerEmail:  l.buyerEmail,
      ticketType:  l.ticketType,
      validatedAt: l.scannedAt,
      validatedBy: l.scannedByName,
      staffId:     l.staffId?.toString() || null,
      method:      l.method,
      result:      l.result,
    }));
  }

  async getCheckinStats(eventId, organizerId) {
    if (!eventId) throw new AppError('eventId is required', 400);
    await this._requireOrganizerEvent(eventId, organizerId);

    const [total, used] = await Promise.all([
      Ticket.countDocuments({ eventId }),
      Ticket.countDocuments({ eventId, $or: [{ status: 'used' }, { validated: true }] }),
    ]);

    return {
      total,
      used,
      remaining: total - used,
      pct: total > 0 ? Math.round((used / total) * 100) : 0,
    };
  }

  async searchTickets({ query, eventId, organizerId }) {
    const q = (query || '').trim();
    if (!q) return [];

    // Escape regex metacharacters — user input cannot inject patterns / ReDoS
    const safe = escapeRegex(q);

    // Only search events the organizer actually owns (never trust eventId alone)
    const organizerEventIds = await this._getOrganizerEventIds(organizerId);
    if (eventId && !organizerEventIds.some((id) => String(id) === String(eventId))) {
      return [];  // eventId not owned by this organizer — return empty, don't leak
    }

    const filter = {
      $or: [
        { id:        { $regex: safe, $options: 'i' } },
        { userEmail: { $regex: safe, $options: 'i' } },
      ],
      eventId: eventId || { $in: organizerEventIds },
    };

    return Ticket.find(filter).limit(20).lean();
  }

  // ── PIN login ───────────────────────────────────────────────
  //  ⚠️ SECURITY NOTES:
  //   1. This is an O(n) bcrypt-compare over all active staff. With 100 staff,
  //      a wrong PIN takes ~10 seconds to reject (100 × 100ms bcrypt). YOU MUST
  //      rate-limit this route in middleware (e.g. authLimiter).
  //   2. PINs are not unique per organizer. If two staff share "1234", the
  //      original code would pick whichever verifyPin() succeeded first — a
  //      random login. We now reject the login in that case.
  //   3. For long-term scale, add a `pinLookupHash` (sha256 of pin+salt) field
  //      on Staff so this becomes an O(1) lookup; keep the bcrypt hash for
  //      actual verification.
  async pinLogin(pin) {
    const pinStr = String(pin ?? '');
    if (pinStr.length < PIN_MIN_LEN || pinStr.length > PIN_MAX_LEN || !/^\d+$/.test(pinStr)) {
      throw new AppError(`PIN must be ${PIN_MIN_LEN}-${PIN_MAX_LEN} digits`, 400);
    }

    // Only staff with a pin set can log in. Cap the candidate set.
    const candidates = await Staff.find({
      status: 'active',
      pin: { $ne: null },
    }).select('+pin').limit(MAX_PIN_CANDIDATES);

    if (candidates.length === MAX_PIN_CANDIDATES) {
      logger.warn('pinLogin candidate cap reached — consider adding indexed lookup', {
        cap: MAX_PIN_CANDIDATES,
      });
    }

    // Collect ALL matches, not just the first — prevents silent collisions
    const matches = [];
    for (const s of candidates) {
      if (await s.verifyPin(pinStr)) matches.push(s);
    }

    if (matches.length === 0) {
      throw new AppError('Invalid PIN.', 401);
    }
    if (matches.length > 1) {
      logger.warn('Multiple staff share the same PIN — login rejected', {
        count: matches.length,
        staffIds: matches.map((m) => m.staffId),
      });
      throw new AppError(
        'Multiple staff share this PIN. Please log in with your staff ID instead, or contact your organizer.',
        409
      );
    }

    const matched = matches[0];

    if (!matched.eventId || !matched.organizerId) {
      throw new AppError('Staff record is missing event or organizer assignment', 500);
    }

    matched.lastLoginAt = new Date();
    await matched.save();

    const token = jwt.sign(
      {
        id:          matched._id.toString(),
        staffId:     matched.staffId,
        name:        matched.name,
        role:        matched.role,
        organizerId: matched.organizerId.toString(),
        eventId:     matched.eventId.toString(),
        type:        'staff',
      },
      config.jwtSecret,
      { expiresIn: '12h' }
    );

    return {
      id:               matched._id.toString(),
      name:             matched.name,
      email:            matched.email,
      role:             matched.role,
      token,
      assignedEventIds: [matched.eventId.toString()],
    };
  }
}

module.exports = new StaffService();
