// controllers/paymentController.js
const paymentService = require('../services/paymentService');
const { AppError } = require('../utils/appError');
const logService = require('../services/logService');

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

// The shape the frontend (and the PDF generator) needs. Same field names the
// free-ticket flow returns from /tickets/purchase, so both paths feed the PDF alike.
const serializeTicket = (t) => ({
  id: t.id,
  eventId: String(t.eventId),
  ticketType: t.ticketType,
  price: t.price,                          // discounted face price actually paid for this ticket
  amountPaid: t.amountPaid,                // face price + buyer-paid processing fee
  buyerName: t.buyerName,
  userEmail: t.userEmail,
  isEarlyBird: !!(t.isEarlyBird || t.earlyBird),
  isGroupTicket: !!t.isGroupTicket,
  totalSlots: t.totalSlots || 1,
  purchasedAt: t.createdAt,
});

// POST /api/payments/initialize
exports.initialize = async (req, res, next) => {
  try {
    const {
      eventId, ticketType, quantity,
      buyerEmail, buyerPhone, buyerName,
      promoCode, groupBooking,
    } = req.body || {};

    if (!eventId || !ticketType || !quantity) {
      throw new AppError('eventId, ticketType, quantity are required', 400);
    }
    if (!buyerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) {
      throw new AppError('Valid buyerEmail is required', 400);
    }

    const result = await paymentService.initializeCharge({
      eventId, ticketType, quantity,
      buyerEmail, buyerPhone, buyerName,
      promoCode: promoCode || null,
      groupBooking: groupBooking || null,
      userId: req.user?.id || null,
    });

    logService.audit(buyerEmail, 'payment_initialized', result.reference, {
      type: 'event',
      adminId: req.user?.id || null,
      amountGHS: result.amountGHS,
      eventId,
      ...ctx(req),
    });

    res.json({
      success: true,
      reference: result.reference,
      authorizationUrl: result.authorizationUrl,
      accessCode: result.accessCode,       // used by the Paystack popup on the frontend
      amount: result.amountGHS,
    });
  } catch (err) { next(err); }
};

// GET /api/payments/verify/:reference
// Called by the frontend after payment (return URL, popup success, or recovery).
// status is one of: 'success' | 'processing' | 'pending' | 'failed'.
// The frontend should keep polling while status is 'pending' or 'processing'.
exports.verify = async (req, res, next) => {
  try {
    const result = await paymentService.verifyAndFulfill(req.params.reference);
    res.json({
      success: result.ok,
      status: result.status,
      tickets: (result.tickets || []).map(serializeTicket),
      alreadyFulfilled: !!result.alreadyFulfilled,
    });
  } catch (err) { next(err); }
};

// POST /api/payments/paystack/webhook — raw body, no JSON parser.
// Must be mounted BEFORE express.json(), with no auth / CSRF / rate-limit in front:
//   app.post('/api/payments/paystack/webhook',
//            express.raw({ type: 'application/json' }), paymentController.webhook);
exports.webhook = async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    await paymentService.handleWebhook(req.body, signature);
    res.sendStatus(200);
  } catch (err) {
    // Paystack retries on non-2xx, so only answer non-2xx for problems it can
    // act on or that WE must fix: a bad signature, or a server misconfiguration
    // (missing secret key, body already parsed as JSON). Anything else returns
    // 200 so Paystack doesn't retry forever; the reconcile job covers those.
    if (err instanceof AppError && (err.statusCode === 401 || err.statusCode === 500)) {
      console.error('[paystack webhook]', err.message);
      return res.status(err.statusCode).send(err.statusCode === 401 ? 'Invalid signature' : 'Webhook misconfigured');
    }
    console.error('[paystack webhook]', err.message);
    res.sendStatus(200);
  }
};
