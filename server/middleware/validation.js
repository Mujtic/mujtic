const Joi = require('joi');
const { AppError } = require('../utils/appError');

// Register schema
const registerSchema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  // Must match models/User.js: minlength 3, maxlength 30, pattern ^[a-z0-9_.]+$
  // — normalizing lowercase/trim here means the model's constraints fire in
  // Joi first with a clean message, not as a raw Mongoose ValidationError.
  username: Joi.string()
    .trim()
    .lowercase()
    .min(3)
    .max(30)
    .pattern(/^[a-z0-9_.]+$/)
    .required(),
  phone: Joi.string().pattern(/^\+233\d{9}$/).required(),
  isOrganizer: Joi.boolean().default(false),
  currency: Joi.string().valid('USD', 'EUR', 'GBP', 'CAD', 'GHC').default('GHC'),
  acceptedTerms: Joi.boolean().valid(true).required()
    .messages({
      'any.only': 'You must accept the Terms of Service and Privacy Policy',
      'any.required': 'You must accept the Terms of Service and Privacy Policy',
    }),
});

// Login schema — accepts email OR username.
// The field name stays `email` (frontend already sends req.body.email),
// but it is no longer validated as an email format, so a username like
// `kwame_23` passes through to userService.login which looks up by
// $or: [{ email }, { username }].
const loginSchema = Joi.object({
  // max(254) caps regex compilation cost downstream — userService.login
  // builds a regex from this value and 10 MB input is a bounded DoS.
  email: Joi.string().max(254).required(),
  password: Joi.string().required(),
});

// Update profile schema — must match userService.updateProfile's ALLOWED
// whitelist: name, phone, avatar, bio, email, username.
const updateProfileSchema = Joi.object({
  name: Joi.string().optional(),
  email: Joi.string().email().optional(),
  phone: Joi.string().pattern(/^\+233\d{9}$/).optional(),
  username: Joi.string()
    .trim()
    .lowercase()
    .min(3)
    .max(30)
    .pattern(/^[a-z0-9_.]+$/)
    .allow('', null)
    .optional(),
  bio: Joi.string().max(500).allow('', null).optional(),
  avatar: Joi.string().allow('', null).optional(),
});

// Event schema — must match eventService.ORGANIZER_WRITABLE_FIELDS and
// models/Event.js.
//
// feePaidBy was removed here: the Event model no longer has it. The fee
// payer is no longer per-event — the platform fee is always paid by the
// organizer and the processing fee is always paid by the buyer, both
// frozen onto each Ticket at purchase time. If a client still sends
// feePaidBy, `stripUnknown: true` drops it before validation.
const eventSchema = Joi.object({
  title: Joi.string().required(),
  description: Joi.string().required(),
  date: Joi.date().iso().required(),
  venue: Joi.string().required(),
  location: Joi.string().optional().allow('', null),
  category: Joi.string().required(),
  currency: Joi.string().valid('USD', 'EUR', 'GBP', 'CAD', 'GHC').required(),
  ticketTypes: Joi.object().pattern(
    Joi.string(),
    Joi.object({
      price: Joi.number().min(0).required(),
      capacity: Joi.number().integer().min(1).required(),
      earlyBirdPrice: Joi.number().min(0).optional().allow(null),
      earlyBirdEnd: Joi.date().iso().optional().allow('', null),
      groupDiscount: Joi.number().min(0).max(50).default(10),
      groupDiscountMinQty: Joi.number().integer().min(1).default(5),
    })
  ).required(),
  image: Joi.string().optional().allow('', null),
  lat: Joi.number().optional().allow(null),
  lng: Joi.number().optional().allow(null),
  address: Joi.string().optional().allow('', null),
  organizerEmail: Joi.string().email().optional(),
  organizerPhone: Joi.string().pattern(/^\+233\d{9}$/).optional(),
  // Added in the model pass — scheduled publication. Without this field in
  // the Joi schema, `stripUnknown: true` would silently discard it and
  // scheduled publishing would be dead again.
  publishAt: Joi.date().iso().optional().allow(null),
});

// Waitlist schema
const waitlistSchema = Joi.object({
  eventId: Joi.string().required(),
  ticketType: Joi.string().required(),
  name: Joi.string().required(),
  email: Joi.string().email().required(),
  phone: Joi.string().pattern(/^\+233\d{9}$/).required(),
});

// ═══════════════════════════════════════════════════════════
//  PAYOUT SCHEMA — aligned with frontend + payoutService
//    canonical methods: bank | mobile_money | paypal | stripe
// ═══════════════════════════════════════════════════════════
const payoutSchema = Joi.object({
  amount: Joi.number()
    .min(10)
    .required()
    .messages({
      'number.base':  'Amount must be a number',
      'number.min':   'Minimum payout amount is ₵10.00',
      'any.required': 'Amount is required',
    }),

  method: Joi.string()
    .valid('bank', 'mobile_money', 'paypal', 'stripe')
    .required()
    .messages({
      'any.only':     'Method must be one of: bank, mobile_money, paypal, stripe',
      'any.required': 'Method is required',
    }),

  email: Joi.string()
    .email()
    .required()
    .messages({
      'string.email': 'Email must be a valid email address',
      'any.required': 'Email is required',
    }),

  notes: Joi.string()
    .allow('', null)
    .max(500)
    .optional()
    .messages({
      'string.max': 'Notes must be 500 characters or fewer',
    }),

  bankDetails: Joi.when('method', {
    is: 'bank',
    then: Joi.object({
      bankName:      Joi.string().required(),
      branchName:    Joi.string().optional().allow('', null),
      accountNumber: Joi.string().required(),
      accountName:   Joi.string().required(),
    }).required(),
    otherwise: Joi.forbidden(),
  }),

  momoDetails: Joi.when('method', {
    is: 'mobile_money',
    then: Joi.object({
      phone: Joi.string().pattern(/^\+233\d{9}$/).required()
        .messages({ 'string.pattern.base': 'MoMo number must be +233XXXXXXXXX' }),
    }).required(),
    otherwise: Joi.forbidden(),
  }),

  details: Joi.object().optional().allow(null),
});

// Convert a waitlist entry into a paid ticket. The admin is recording the
// out-of-band payment, so the reference and gateway are required — this is
// the only audit trail linking the ticket to the money that was collected.
const convertWaitlistSchema = Joi.object({
  ticketType: Joi.string().required(),
  paymentReference: Joi.string().trim().min(1).max(100).required()
    .messages({
      'string.empty': 'Payment reference is required (gateway ID, MoMo receipt, or bank ref)',
      'any.required': 'Payment reference is required (gateway ID, MoMo receipt, or bank ref)',
    }),
  paymentGateway: Joi.string().valid('stripe', 'paystack', 'paypal', 'manual').required()
    .messages({
      'any.only':     'Payment gateway must be one of: stripe, paystack, paypal, manual',
      'any.required': 'Payment gateway is required',
    }),
  // Optional overrides; the service defaults amountPaid to the calculated
  // buyer total and paidAt to now.
  amountPaid: Joi.number().min(0).optional().allow(null),
  paidAt: Joi.date().iso().optional().allow(null),
});

// Deactivate account schema
const deactivateSchema = Joi.object({
  password: Joi.string().required(),
});

// Generic validation middleware factory
const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });
  if (error) {
    const messages = error.details.map((d) => d.message).join(', ');
    // Route through errorHandler so validation failures get the same
    // { success: false, message } shape as every other error path, plus
    // winston logging on 4xx.
    return next(new AppError(messages, 400));
  }
  req.body = value;          // write coerced/whitelisted values back
  next();
};

const sanitizeText = (field) => (req, res, next) => { next(); };

module.exports = {
  registerSchema,
  loginSchema,
  updateProfileSchema,
  eventSchema,
  waitlistSchema,
  payoutSchema,
  convertWaitlistSchema,
  validate,
  sanitizeText,
  deactivateSchema,
};
