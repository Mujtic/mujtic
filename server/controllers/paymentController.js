// controllers/paymentController.js
const paymentService = require('../services/paymentService');
const { AppError } = require('../utils/appError');
const logService = require('../services/logService');

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

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
      amount: result.amountGHS,
    });
  } catch (err) { next(err); }
};

// GET /api/payments/verify/:reference — called by frontend on callback page load
exports.verify = async (req, res, next) => {
  try {
    const result = await paymentService.verifyAndFulfill(req.params.reference);
    res.json({
      success: true,
      status: result.payment?.status,
      tickets: (result.tickets || []).map((t) => ({
        id: t.id, ticketType: t.ticketType, amountPaid: t.amountPaid,
      })),
      alreadyFulfilled: !!result.alreadyFulfilled,
    });
  } catch (err) { next(err); }
};

// POST /api/payments/paystack/webhook — raw body, no JSON parser
exports.webhook = async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    await paymentService.handleWebhook(req.body, signature);
    res.sendStatus(200);
  } catch (err) {
    // Paystack expects 200 even on internal errors so it won't retry forever.
    // Only signature failures get a non-2xx so Paystack knows the endpoint is misconfigured.
    if (err instanceof AppError && err.statusCode === 401) {
      return res.status(401).send('Invalid signature');
    }
    console.error('[paystack webhook]', err.message);
    res.sendStatus(200);
  }
};
