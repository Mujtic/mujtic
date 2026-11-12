const userService = require('../services/userService');
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
