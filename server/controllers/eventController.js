// controllers/eventController.js
const eventService = require('../services/eventService');
const logService = require('../services/logService');
const Event = require('../models/Event'); // only used to read the title/image before an event is deleted or updated
const { uploadSingle } = require('../config/multer');
const { uploadImage, deleteImage, keyFromUrl } = require('../services/storageService');
const { AppError } = require('../utils/appError');

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

// Helper to parse ticketTypes if it's a string (FormData submissions).
// Throws AppError on bad JSON so errorHandler maps it to 400, not 500.
const parseTicketTypes = (req) => {
  if (req.body.ticketTypes && typeof req.body.ticketTypes === 'string') {
    try {
      req.body.ticketTypes = JSON.parse(req.body.ticketTypes);
    } catch {
      throw new AppError('Invalid ticketTypes JSON', 400);
    }
  }
};

// Coerce query string → typed filters. Without this, `?upcoming=false`
// would still filter (because "false" is a truthy string).
const parseEventFilters = (query = {}) => ({
  search:      typeof query.search === 'string' ? query.search : undefined,
  category:    typeof query.category === 'string' ? query.category : undefined,
  location:    typeof query.location === 'string' ? query.location : undefined,
  organizerId: typeof query.organizerId === 'string' ? query.organizerId : undefined,
  upcoming:    query.upcoming === 'true' || query.upcoming === '1',
  flagged:     query.flagged === 'true' || query.flagged === '1',
  limit:       query.limit,
  skip:        query.skip,
});

exports.createEvent = [
  uploadSingle('image'),
  async (req, res, next) => {
    let uploadedKey = null;   // track so we can clean up if DB save fails
    try {
      parseTicketTypes(req);

      // Upload to R2 before creating the event. If the DB write fails
      // afterwards, the catch block removes the R2 object so we never
      // accumulate orphaned images from failed creates.
      let imageUrl = null;
      if (req.file) {
        const uploaded = await uploadImage(req.file.buffer, {
          folder: 'events',
          originalName: req.file.originalname,
        });
        imageUrl = uploaded.url;
        uploadedKey = uploaded.key;
      }

      const event = await eventService.createEvent(req.user.id, req.body, imageUrl);
      logService.audit(req.user.email, 'create_event', event?.title || req.body?.title, {
        type: 'event', adminId: req.user.id, eventId: String(event?._id || event?.id || ''), ...ctx(req),
      });
      res.status(201).json(event);
    } catch (err) {
      // Cleanup: R2 upload succeeded but event creation failed
      if (uploadedKey) deleteImage(uploadedKey);
      next(err);
    }
  }
];

exports.getEvents = async (req, res, next) => {
  try {
    const filters = parseEventFilters(req.query);
    const events = await eventService.getEvents(filters);
    res.json(events);
  } catch (err) {
    next(err);
  }
};

exports.getEvent = async (req, res, next) => {
  try {
    const event = await eventService.getEventById(req.params.id);
    res.json(event);
  } catch (err) {
    next(err);
  }
};

exports.updateEvent = [
  uploadSingle('image'),
  async (req, res, next) => {
    let uploadedKey = null;
    try {
      parseTicketTypes(req);

      // Read the previous image URL BEFORE the update so we can delete the
      // orphaned R2 object after success. Ownership check is duplicated here
      // only to prevent leaking the image URL on non-owned events — the
      // service re-checks authoritatively and is the source of truth.
      let oldImage = null;
      try {
        const existing = await Event.findById(req.params.id).select('image organizerId').lean();
        if (existing && String(existing.organizerId) === String(req.user.id)) {
          oldImage = existing.image;
        }
      } catch {
        // Malformed id — let the service surface the proper 400/404
      }

      // Upload new image if provided. `undefined` tells the service to leave
      // the existing image untouched — distinct from `null` which would clear it.
      let imageUrl = undefined;
      if (req.file) {
        const uploaded = await uploadImage(req.file.buffer, {
          folder: 'events',
          originalName: req.file.originalname,
        });
        imageUrl = uploaded.url;
        uploadedKey = uploaded.key;
      }

      const event = await eventService.updateEvent(req.params.id, req.user.id, req.body, imageUrl);

      // Successful update + new image ⇒ old image is now orphaned. Delete it
      // from R2 so the bucket doesn't slowly fill with unused posters.
      // Non-R2 old URLs (legacy /uploads/ paths) return null from keyFromUrl
      // and are silently skipped.
      if (oldImage && imageUrl && oldImage !== imageUrl) {
        const oldKey = keyFromUrl(oldImage);
        if (oldKey) deleteImage(oldKey);
      }

      // Field names only, never values
      logService.audit(req.user.email, 'update_event', event?.title || req.params.id, {
        type: 'event', adminId: req.user.id, eventId: req.params.id,
        submittedFields: Object.keys(req.body || {}), imageChanged: !!req.file, ...ctx(req),
      });
      res.json(event);
    } catch (err) {
      // Cleanup: R2 upload succeeded but DB update failed
      if (uploadedKey) deleteImage(uploadedKey);
      next(err);
    }
  }
];

exports.deleteEvent = async (req, res, next) => {
  try {
    // Pre-read the title and image only if the requester actually owns the
    // event — prevents non-owners from confirming existence via the audit
    // path. The service re-checks ownership authoritatively.
    let before = null;
    try {
      const ev = await Event.findById(req.params.id).select('title organizerId image').lean();
      if (ev && String(ev.organizerId) === String(req.user.id)) {
        before = { title: ev.title, image: ev.image };
      }
    } catch {
      // Malformed id — let the service surface the proper 400/404
    }

    await eventService.deleteEvent(req.params.id, req.user.id);

    // R2 cleanup — best-effort. A missing R2 object never blocks a successful
    // DB delete; the alternative (failing the whole request because the CDN
    // hiccupped) would leave the event stuck in an undeletable state.
    if (before?.image) {
      const key = keyFromUrl(before.image);
      if (key) deleteImage(key);
    }

    logService.audit(req.user.email, 'delete_event', before?.title || req.params.id, {
      type: 'danger', adminId: req.user.id, eventId: req.params.id, ...ctx(req),
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

exports.togglePublish = async (req, res, next) => {
  try {
    const event = await eventService.togglePublish(req.params.id, req.user.id);
    // Only log when we know the saved state, so the label can't be inverted
    if (typeof event?.isPublished === 'boolean') {
      logService.audit(req.user.email, event.isPublished ? 'publish_event' : 'unpublish_event', event.title || req.params.id, {
        type: 'event', adminId: req.user.id, eventId: req.params.id, ...ctx(req),
      });
    }
    res.json(event);
  } catch (err) {
    next(err);
  }
};

exports.cancelEvent = async (req, res, next) => {
  try {
    const event = await eventService.cancelEvent(req.params.id, req.user.id);
    logService.audit(req.user.email, 'cancel_event', event?.title || req.params.id, {
      type: 'danger', adminId: req.user.id, eventId: req.params.id, ...ctx(req),
    });
    res.json(event);
  } catch (err) {
    next(err);
  }
};

// NOTE: flagEvent / unflagEvent were removed from this controller.
// Admin event moderation lives in adminController (which gates on the
// /api/admin/* route stack — not on req.user.isAdmin from the JWT).
// See the route-check block below before deploying.
