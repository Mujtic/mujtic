const userService = require('../services/userService');
const Event = require('../models/Event');
const logService = require('../services/logService');
const { logger } = require('../config/logger');

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

// POST /api/cron/process-deletions
// Anonymizes every user whose 30-day deletion grace has expired.
// Idempotent: safe to call multiple times in the same day.
// Triggered by: Render Cron Job (via X-Cron-Secret) or an admin (via JWT).
exports.processScheduledDeletions = async (req, res, next) => {
  try {
    const result = await userService.processDueDeletions(50);

    if (result.processed > 0 || result.failed > 0) {
      logger.info('Scheduled deletions processed', result);
    }

    // Audit is best-effort — a logging failure must not fail the run.
    // type: 'danger' (not 'system') so we don't depend on the Log enum
    // having a 'system' value; the action field distinguishes this entry.
    try {
      const trigger = req.user?.email || 'cron-scheduler';
      logService.audit(trigger, 'run_scheduled_deletions', 'cron', {
        type: 'danger',
        processed: result.processed,
        failed: result.failed,
        ...ctx(req),
      });
    } catch (auditErr) {
      logger.error('Cron audit log failed (non-fatal)', { err: auditErr.message });
    }

    res.json(result);
  } catch (err) {
    logger.error('Scheduled deletion job crashed', { err: err.message, ...ctx(req) });
    next(err);
  }
};


// POST /api/cron/publish-events
// Publishes every event whose scheduled publishAt has arrived.
// Idempotent: the WHERE clause excludes already-published events.
// Triggered by: Render Cron Job (via X-Cron-Secret) or an admin (via JWT).
exports.publishScheduledEvents = async (req, res, next) => {
  try {
    const now = new Date();

    // Two-phase: fetch first (so we can audit which events flipped), then
    // bulk-update. Fetch is bounded by how many events can be scheduled for
    // the same minute — typically zero to a handful.
    const due = await Event.find({
      publishAt: { $lte: now, $ne: null },
      isPublished: false,
      isCancelled: false,
    }).select('_id title organizerId').lean();

    if (!due.length) {
      return res.json({ published: 0, ids: [] });
    }

    const result = await Event.updateMany(
      { _id: { $in: due.map(e => e._id) } },
      { $set: { isPublished: true, publishAt: null } }
    );

    logger.info('Scheduled events published', {
      published: result.modifiedCount,
      ids: due.map(e => String(e._id)),
    });

    // Audit is best-effort — a logging failure must not fail the run.
    try {
      const trigger = req.user?.email || 'cron-scheduler';
      logService.audit(trigger, 'run_scheduled_event_publish', 'cron', {
        type: 'event',
        published: result.modifiedCount,
        ...ctx(req),
      });
    } catch (auditErr) {
      logger.error('Cron audit log failed (non-fatal)', { err: auditErr.message });
    }

    res.json({ published: result.modifiedCount, ids: due.map(e => String(e._id)) });
  } catch (err) {
    logger.error('Scheduled event publish job crashed', { err: err.message, ...ctx(req) });
    next(err);
  }
};
