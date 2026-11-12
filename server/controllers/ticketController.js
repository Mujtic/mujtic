const ticketService = require('../services/ticketService');
const logService = require('../services/logService');

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

// All-in checkout price, shown to the buyer BEFORE they pay. Read-only: it
// never reserves tickets or uses up a promo code. It runs through the same
// pricing as purchase(), so the number the buyer sees is the number they pay.
exports.quote = async (req, res, next) => {
  try {
    const { eventId, ticketType, quantity, promoCode } = req.body || {};
    const quote = await ticketService.quotePurchase(
      { eventId, ticketType, quantity, promoCode: promoCode || null },
      req.user?.id || null          // null for guests
    );
    res.json(quote);
  } catch (err) {
    next(err);
  }
};

exports.purchase = async (req, res, next) => {
  try {
    const {
      eventId, ticketType, quantity, paymentDetails,
      groupBooking, promoCode, buyerName,
    } = req.body || {};

    const tickets = await ticketService.purchaseTicket(
      req.user?.id || null,       // null for guests
      eventId,
      ticketType,
      quantity,
      paymentDetails,
      groupBooking || {},
      promoCode || null,
      buyerName || null
    );

    // paymentDetails is never logged. Logged-in buyers are audited in MongoDB;
    // guest purchases go to the winston files only.
    const details = {
      eventId: String(eventId), ticketType, quantity,
      groupBooking: !!groupBooking, promoCode: promoCode || undefined,
      ticketCount: Array.isArray(tickets) ? tickets.length : 1, ...ctx(req),
    };

    if (req.user) {
      logService.audit(req.user.email, 'purchase_tickets', String(eventId), {
        type: 'event', adminId: req.user.id, ...details,
      });
    } else {
      logService.trace('event', `guest -> purchase_tickets ${eventId}`, details);
    }

    res.status(201).json(tickets);
  } catch (err) {
    next(err);
  }
};

exports.getEventTickets = async (req, res, next) => {
  try {
    const { eventId, ticketType, limit } = req.query;
    const tickets = await ticketService.getEventTickets(
      eventId,
      req.user.isOrganizer ? req.user.id : null,
      { ticketType, limit: Number(limit) || 5000 }
    );
    res.json(tickets);
  } catch (err) { next(err); }
};

exports.getMyTickets = async (req, res, next) => {
  try {
    const tickets = await ticketService.getUserTickets(req.user.id);
    res.json(tickets);
  } catch (err) {
    next(err);
  }
};

exports.validateTicket = async (req, res, next) => {
  try {
    const ticketId = req.params.id;
    const ticket = await ticketService.validateTicket(ticketId, {
      id: req.user.id,
      isAdmin: req.user.isAdmin,
    });

    logService.audit(req.user.email, 'validate_ticket', String(ticketId), {
      type: 'event', adminId: req.user.id,
      ticketId: String(ticketId),
      eventId: String(ticket.eventId?._id || ticket.eventId),
      ...ctx(req),
    });

    res.json(ticket);
  } catch (err) {
    next(err);
  }
};

exports.cancelTicket = async (req, res, next) => {
  try {
    const ticketId = req.params.id;
    const ticket = await ticketService.cancelTicket(ticketId, {
      id: req.user.id,
      isAdmin: req.user.isAdmin,
    });

    logService.audit(req.user.email, 'cancel_ticket', String(ticketId), {
      type: 'danger', adminId: req.user.id, ticketId: String(ticketId), ...ctx(req),
    });

    res.json(ticket);
  } catch (err) {
    next(err);
  }
};
