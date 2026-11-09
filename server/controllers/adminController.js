const adminService = require('../services/adminService');
const logService = require('../services/logService');
const Event = require('../models/Event');
const User = require('../models/User'); // only used to read a record before it is deleted / its role changes

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

exports.getStats = async (req, res, next) => {
  try {
    const stats = await adminService.getStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
};

exports.getAllUsers = async (req, res, next) => {
  try {
    const users = await adminService.getAllUsers();
    res.json(users);
  } catch (err) {
    next(err);
  }
};

exports.createUser = async (req, res, next) => {
  try {
    const user = await adminService.createUser(req.body);
    logService.audit(req.user.email, 'create_user', user?.email || req.body?.email, {
      type: 'user', adminId: req.user.id, targetRole: user?.role, ...ctx(req),
    });
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
};

exports.updateUser = async (req, res, next) => {
  try {
    const user = await adminService.updateUser(req.params.id, req.body, req.user.role);
    // Field names only, never values
    const submittedFields = Object.keys(req.body || {}).filter((k) => k !== 'password');
    logService.audit(req.user.email, 'update_user', user?.email || req.params.id, {
      type: 'user', adminId: req.user.id, targetRole: user?.role, submittedFields, ...ctx(req),
    });
    res.json(user);
  } catch (err) {
    next(err);
  }
};

exports.suspendUser = async (req, res, next) => {
  try {
    const result = await adminService.suspendUser(req.user.id, req.params.id);

    // Works whether the service returns the user or { user, suspended }
    const target = result?.user || result;
    const suspended = result?.suspended ?? target?.suspended;

    if (typeof suspended === 'boolean') {
      logService.audit(req.user.email, suspended ? 'suspend_user' : 'unsuspend_user', target?.email || req.params.id, {
        type: 'user', adminId: req.user.id, targetRole: target?.role, ...ctx(req),
      });
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
};

exports.cancelEvent = async (req, res, next) => {
  try {
    const event = await adminService.cancelEvent(req.user.id, req.params.id);
    logService.audit(req.user.email, 'cancel_event', event?.title || req.params.id, {
      type: 'danger', adminId: req.user.id, eventId: req.params.id, ...ctx(req),
    });
    res.json(event);
  } catch (err) {
    next(err);
  }
};

exports.restoreEvent = async (req, res, next) => {
  try {
    const event = await adminService.restoreEvent(req.user.id, req.params.id);
    logService.audit(req.user.email, 'restore_event', event?.title || req.params.id, {
      type: 'event', adminId: req.user.id, eventId: req.params.id, ...ctx(req),
    });
    res.json(event);
  } catch (err) {
    next(err);
  }
};

exports.deleteUser = async (req, res, next) => {
  try {
    const target = await User.findById(req.params.id).select('email role').lean();
    await adminService.deleteUser(req.user.id, req.params.id);
    logService.audit(req.user.email, 'delete_user', target?.email || req.params.id, {
      type: 'danger', adminId: req.user.id, targetRole: target?.role, ...ctx(req),
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

exports.changeUserRole = async (req, res, next) => {
  try {
    const { role } = req.body;
    const before = await User.findById(req.params.id).select('role').lean();
    const user = await adminService.changeUserRole(req.user.id, req.params.id, role);
    // Anything involving the admin role is logged as danger
    const privileged = role === 'admin' || before?.role === 'admin';
    logService.audit(req.user.email, 'change_role', user?.email || req.params.id, {
      type: privileged ? 'danger' : 'user', adminId: req.user.id,
      previousRole: before?.role, newRole: user?.role || role, ...ctx(req),
    });
    res.json(user);
  } catch (err) {
    next(err);
  }
};

exports.getAllEvents = async (req, res, next) => {
  try {
    const events = await adminService.getAllEvents();
    res.json(events);
  } catch (err) {
    next(err);
  }
};

exports.flagEvent = async (req, res, next) => {
  try {
    const event = await adminService.flagEvent(req.params.id);
    logService.audit(req.user.email, 'flag_event', event?.title || req.params.id, {
      type: 'event', adminId: req.user.id, eventId: req.params.id, ...ctx(req),
    });
    res.json(event);
  } catch (err) {
    next(err);
  }
};

exports.unflagEvent = async (req, res, next) => {
  try {
    const event = await adminService.unflagEvent(req.params.id);
    logService.audit(req.user.email, 'unflag_event', event?.title || req.params.id, {
      type: 'event', adminId: req.user.id, eventId: req.params.id, ...ctx(req),
    });
    res.json(event);
  } catch (err) {
    next(err);
  }
};

exports.deleteEvent = async (req, res, next) => {
  try {
    const before = await Event.findById(req.params.id).select('title').lean();
    await adminService.deleteEvent(req.params.id);
    logService.audit(req.user.email, 'delete_event', before?.title || req.params.id, {
      type: 'danger', adminId: req.user.id, eventId: req.params.id, ...ctx(req),
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

exports.getAllTickets = async (req, res, next) => {
  try {
    const tickets = await adminService.getAllTickets();
    res.json(tickets);
  } catch (err) {
    next(err);
  }
};

exports.getAllPayouts = async (req, res, next) => {
  try {
    const payouts = await adminService.getAllPayouts();
    res.json(payouts);
  } catch (err) {
    next(err);
  }
};

exports.approvePayout = async (req, res, next) => {
  try {
    const payout = await adminService.approvePayout(req.params.id, req.user.id);
    logService.audit(req.user.email, 'approve_payout', String(req.params.id), {
      type: 'payout', adminId: req.user.id, amount: payout?.amount,
      organizerId: String(payout?.organizerId?._id || payout?.organizerId || ''), ...ctx(req),
    });
    res.json(payout);
  } catch (err) {
    next(err);
  }
};

exports.rejectPayout = async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Rejection reason required' });
    const payout = await adminService.rejectPayout(req.params.id, reason, req.user.id);
    logService.audit(req.user.email, 'reject_payout', String(req.params.id), {
      type: 'payout', adminId: req.user.id, amount: payout?.amount,
      organizerId: String(payout?.organizerId?._id || payout?.organizerId || ''),
      reason: String(reason).slice(0, 300), ...ctx(req),
    });
    res.json(payout);
  } catch (err) {
    next(err);
  }
};

exports.togglePublish = async (req, res, next) => {
  try {
    const event = await adminService.togglePublish(req.params.id);
    logService.audit(req.user.email, event.isPublished ? 'publish_event' : 'unpublish_event', event.title || req.params.id, {
      type: 'event', adminId: req.user.id, eventId: req.params.id, ...ctx(req),
    });
    res.json(event);
  } catch (err) {
    next(err);
  }
};

// Waitlist Management
exports.getAllWaitlists = async (req, res, next) => {
  try {
    const waitlists = await adminService.getAllWaitlists();
    res.json(waitlists);
  } catch (err) {
    next(err);
  }
};

exports.notifyWaitlistEntry = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { channel, message } = req.body;
    const result = await adminService.notifyWaitlistEntry(id, channel, message);
    // Channel only; the message text is not stored
    logService.audit(req.user.email, 'notify_waitlist', String(id), {
      type: 'event', adminId: req.user.id, channel, ...ctx(req),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

exports.convertWaitlistToTicket = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      ticketType,
      paymentReference,
      paymentGateway,
      amountPaid,     // optional — defaults to calculated buyer total
      paidAt,         // optional ISO date — defaults to now
    } = req.body || {};

    const result = await adminService.convertWaitlistToTicket(id, ticketType, {
      paymentReference,
      paymentGateway,
      amountPaid,
      paidAt,
    });

    logService.audit(req.user.email, 'convert_waitlist', String(id), {
      type: 'event', adminId: req.user.id, ticketType,
      paymentGateway,
      // Reference is the gateway's transaction ID / MoMo receipt — not PII,
      // but cap it so a garbage string can't blow up the audit doc.
      paymentReference: String(paymentReference || '').slice(0, 100),
      amountPaid: result?.ticket?.amountPaid,
      alreadyConverted: !!result?.alreadyConverted,
      ...ctx(req),
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
};

exports.deleteWaitlistEntry = async (req, res, next) => {
  try {
    const { id } = req.params;
    await adminService.deleteWaitlistEntry(id);
    logService.audit(req.user.email, 'delete_waitlist_entry', String(id), {
      type: 'event', adminId: req.user.id, ...ctx(req),
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

exports.getAllCoupons = async (req, res, next) => {
  try {
    const coupons = await adminService.getAllCoupons();
    res.json(coupons);
  } catch (err) {
    next(err);
  }
};

exports.completePayout = async (req, res, next) => {
  try {
    const payout = await adminService.completePayout(req.user.id, req.params.id, req.body?.paymentReference);
    logService.audit(req.user.email, 'complete_payout', String(req.params.id), {
      type: 'payout', adminId: req.user.id, payoutId: req.params.id,
      amount: payout?.amount, method: payout?.method, ...ctx(req),
    });
    res.json(payout);
  } catch (err) {
    next(err);
  }
};
