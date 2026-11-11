const staffService = require('../services/staffService');
const logService = require('../services/logService');
const { AppError } = require('../utils/appError');

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

// Resolve the acting principal from req.user. User tokens (from userService.login)
// have { id, email, role, isOrganizer, isAdmin }. Staff tokens (from
// staffService.pinLogin) have { id: Staff._id, staffId: code, organizerId: User._id,
// eventId, role, type: 'staff' }.
//
// organizerId → the User._id who owns the event (the JWT's `id` for organizers,
//               the JWT's `organizerId` for staff)
// userId      → the token subject (User._id for organizers, Staff._id for staff)
// staffId     → Staff._id when the caller IS staff, otherwise null
// staffCode   → human staff code (S1234ABCD) when the caller IS staff
const resolveActor = (req) => {
  const u = req.user || {};
  const isStaff = u.type === 'staff';
  return {
    isStaff,
    isAdmin: !!u.isAdmin,
    userId: u.id,
    organizerId: isStaff ? u.organizerId : u.id,
    staffId: isStaff ? u.id : null,
    staffCode: isStaff ? (u.staffId || 'staff') : null,
    email: u.email,
    displayName: u.email || (isStaff ? (u.staffId || 'staff') : 'unknown'),
  };
};

// ─────────────────────────────────────────────────────────────
//  Staff management — organizer-only (not staff, not admin via this path)
// ─────────────────────────────────────────────────────────────
exports.createStaff = async (req, res, next) => {
  try {
    const actor = resolveActor(req);
    if (actor.isStaff) throw new AppError('Staff cannot manage staff accounts', 403);

    const staff = await staffService.createStaff(actor.userId, req.body || {});
    // The PIN is never logged
    const staffId = String(staff?._id || staff?.id || '');
    logService.audit(actor.email, 'create_staff', staff?.name || staffId, {
      type: 'user', adminId: actor.userId, staffId, ...ctx(req),
    });
    res.status(201).json(staff);
  } catch (err) { next(err); }
};

exports.listStaff = async (req, res, next) => {
  try {
    const actor = resolveActor(req);
    if (actor.isStaff) throw new AppError('Staff cannot list staff accounts', 403);

    const list = await staffService.listStaff(actor.userId, req.query.eventId || null);
    res.json(list);
  } catch (err) { next(err); }
};

exports.getStaff = async (req, res, next) => {
  try {
    const actor = resolveActor(req);
    if (actor.isStaff) throw new AppError('Staff cannot view staff accounts', 403);

    const staff = await staffService.getStaff(req.params.id, actor.userId);
    res.json(staff);
  } catch (err) { next(err); }
};

exports.setStatus = async (req, res, next) => {
  try {
    const actor = resolveActor(req);
    if (actor.isStaff) throw new AppError('Staff cannot change staff status', 403);

    const staff = await staffService.setStatus(
      req.params.id, actor.userId, req.body?.status
    );
    logService.audit(actor.email, 'set_staff_status', staff?.name || req.params.id, {
      type: 'user', adminId: actor.userId, staffId: req.params.id,
      status: req.body?.status, ...ctx(req),
    });
    res.json(staff);
  } catch (err) { next(err); }
};

exports.deleteStaff = async (req, res, next) => {
  try {
    const actor = resolveActor(req);
    if (actor.isStaff) throw new AppError('Staff cannot delete staff accounts', 403);

    const before = await staffService.getStaff(req.params.id, actor.userId);
    await staffService.deleteStaff(req.params.id, actor.userId);

    logService.audit(actor.email, 'delete_staff', before?.name || req.params.id, {
      type: 'danger', adminId: actor.userId, staffId: req.params.id, ...ctx(req),
    });

    res.status(200).json({ ok: true, id: req.params.id });   // ← 200 + body
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────
//  PIN login — public
// ─────────────────────────────────────────────────────────────
exports.pinLogin = async (req, res, next) => {
  try {
    const result = await staffService.pinLogin(req.body?.pin);
    // Anonymous endpoint: winston files only, and the PIN is never logged
    logService.trace('auth', 'staff -> pin_login', ctx(req));
    res.json(result);
  } catch (err) {
    logService.trace('warning', 'staff -> pin_login_failed', {
      reason: err.message, ...ctx(req),
    });
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────
//  Ticket validation — works for both organizers and staff
// ─────────────────────────────────────────────────────────────
exports.validateTicket = async (req, res, next) => {
  try {
    const actor = resolveActor(req);

    const result = await staffService.validateTicket({
      ticketId:    req.params.ticketId,
      eventId:     req.body?.eventId,
      organizerId: actor.organizerId,
      // For staff scans: no User._id to attribute. For organizer scans: the
      // organizer is the actor, so use their own id.
      scannedById: actor.isStaff ? null : actor.userId,
      // Staff scanning: their Staff._id. Organizer scanning: whatever staffId
      // the organizer passes (for delegating attribution), or null.
      staffId:     actor.isStaff ? actor.staffId : (req.body?.staffId || null),
      staffName: actor.isStaff ? (actor.name || actor.staffCode) : 'organizer',
      method:      req.body?.method || 'manual',
      device:      req.headers['user-agent'] || null,
      ip:          req.ip,
    });

    const statusCode = result.result === 'valid'          ? 200
      : result.result === 'already_used'                  ? 409
        : result.result === 'invalid'                     ? 403
          : result.result === 'wrong_event'               ? 400
            : result.result === 'refunded'                ? 400
              : result.result === 'refund_pending'        ? 400
                : result.result === 'cancelled'           ? 400
                  : 404;

    const details = {
      ticketId: req.params.ticketId, eventId: req.body?.eventId,
      result: result.result, method: req.body?.method || 'manual',
      staffId: actor.isStaff ? actor.staffId : (req.body?.staffId || undefined),
      ...ctx(req),
    };

    // Valid scans land in the service's scan logs — winston only.
    // Rejected scans go to the audit collection.
    if (result.result === 'valid') {
      logService.trace('event', `${actor.displayName} -> scan_valid ${req.params.ticketId}`, details);
    } else {
      logService.audit(actor.displayName, 'scan_rejected', String(req.params.ticketId), {
        type: 'warning', adminId: actor.userId, ...details,
      });
    }

    res.status(statusCode).json(result);
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────
//  Scan logs / stats / ticket search — organizer-only
//  (Staff supervisors can view their own event's data via a future
//   dedicated endpoint; for now staff gets 403 from _requireOrganizerEvent)
// ─────────────────────────────────────────────────────────────
exports.getScanLogs = async (req, res, next) => {
  try {
    const actor = resolveActor(req);
    const { eventId, limit, staffFilter } = req.query;
    const logs = await staffService.getScanLogs({
      organizerId: actor.userId,
      eventId, limit, staffFilter,
    });
    res.json(logs);
  } catch (err) { next(err); }
};

exports.getCheckinStats = async (req, res, next) => {
  try {
    const actor = resolveActor(req);
    const stats = await staffService.getCheckinStats(req.query.eventId, actor.userId);
    res.json(stats);
  } catch (err) { next(err); }
};

exports.searchTickets = async (req, res, next) => {
  try {
    const actor = resolveActor(req);
    const tickets = await staffService.searchTickets({
      query:       req.query.q,
      eventId:     req.query.eventId,
      organizerId: actor.userId,
    });
    res.json(tickets);
  } catch (err) { next(err); }
};
