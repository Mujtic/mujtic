// controllers/cronController.js
const userService = require('../services/userService');
const paymentService = require('../services/paymentService');
const Event = require('../models/Event');
const Payment = require('../models/Payment');
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


// ─────────────────────────────────────────────────────────────
// POST /api/cron/reconcile-payments
// Safety net behind the Paystack webhook. Re-verifies payments that never
// reached "fulfilled" (webhook missed, fulfilment crashed, buyer closed the tab
// before returning) and creates the tickets if Paystack confirms they were paid.
// Idempotent: verifyAndFulfill claims each payment atomically, so overlapping
// runs, the webhook and the buyer's browser can never double-create tickets.
// Triggered by: Render Cron Job every 5 minutes (via X-Cron-Secret) or an admin.
// ─────────────────────────────────────────────────────────────
const RECONCILE_MIN_AGE_MS     = 2 * 60 * 1000;           // give the webhook / redirect a head start
const RECONCILE_PENDING_MAX_MS = 3 * 60 * 60 * 1000;      // unpaid checkouts: stop polling Paystack after 3h
const RECONCILE_PAID_MAX_MS    = 3 * 24 * 60 * 60 * 1000; // paid but not fulfilled: this is real money, keep trying
const RECONCILE_BATCH          = 25;                      // per group, per run
const RECONCILE_CONCURRENCY    = 5;

let reconcileRunning = false;                             // overlapping runs are harmless, but pointless

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.allSettled(items.slice(i, i + size).map(fn));
  }
}

exports.reconcilePayments = async (req, res, next) => {
  if (reconcileRunning) {
    return res.json({ skipped: true, reason: 'previous run still in progress' });
  }
  reconcileRunning = true;

  try {
    const now = Date.now();
    const olderThan = new Date(now - RECONCILE_MIN_AGE_MS);

    // Paid but never fulfilled go first, so abandoned checkouts can't starve them.
    const paidStuck = await Payment.find({
      fulfilledAt: null,
      status: 'success',
      createdAt: { $gt: new Date(now - RECONCILE_PAID_MAX_MS), $lt: olderThan },
    }).sort({ createdAt: 1 }).limit(RECONCILE_BATCH).select('reference').lean();

    // Checkouts still waiting on Paystack (e.g. mobile money approval)
    const pending = await Payment.find({
      fulfilledAt: null,
      status: 'pending',
      createdAt: { $gt: new Date(now - RECONCILE_PENDING_MAX_MS), $lt: olderThan },
    }).sort({ createdAt: -1 }).limit(RECONCILE_BATCH).select('reference').lean();

    const refs = [...paidStuck, ...pending].map((p) => p.reference);
    const tally = { checked: refs.length, fulfilled: 0, processing: 0, stillPending: 0, failed: 0, errors: 0 };

    await inBatches(refs, RECONCILE_CONCURRENCY, async (reference) => {
      try {
        const r = await paymentService.verifyAndFulfill(reference);
        if (r.status === 'success' && !r.alreadyFulfilled) tally.fulfilled++;
        else if (r.status === 'processing') tally.processing++;
        else if (r.status === 'pending')    tally.stillPending++;
        else if (r.status === 'failed')     tally.failed++;
      } catch (e) {
        tally.errors++;
        logger.error('Reconcile failed for payment', { reference, err: e.message });
      }
    });

    if (tally.fulfilled > 0 || tally.errors > 0) {
      logger.info('Payment reconcile finished', tally);
    }

    // Audit only when the job actually rescued something: a 5-minute no-op run isn't worth a row.
    if (tally.fulfilled > 0) {
      try {
        const trigger = req.user?.email || 'cron-scheduler';
        logService.audit(trigger, 'run_payment_reconcile', 'cron', {
          type: 'event',
          fulfilled: tally.fulfilled,
          errors: tally.errors,
          ...ctx(req),
        });
      } catch (auditErr) {
        logger.error('Cron audit log failed (non-fatal)', { err: auditErr.message });
      }
    }

    res.json(tally);
  } catch (err) {
    logger.error('Payment reconcile job crashed', { err: err.message, ...ctx(req) });
    next(err);
  } finally {
    reconcileRunning = false;
  }
};
