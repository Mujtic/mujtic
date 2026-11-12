const userService = require('../services/userService');
const logService = require('../services/logService');
const { logger } = require('../config/logger');

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

exports.register = async (req, res, next) => {
  try {
    const user = await userService.register(req.body || {});
    logService.audit(user.email, 'register', user.email, {
      type: 'auth', adminId: user._id, role: user.role, ...ctx(req),
    });
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
};

exports.login = async (req, res, next) => {
  const { email, password } = req.body || {};
  try {
    const result = await userService.login(email, password);
    logService.audit(result.user.email, 'login', result.user.email, {
      type: 'auth', adminId: result.user._id, role: result.user.role, ...ctx(req),
    });
    res.json(result);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    const attempted = (email || '').toString().trim();
    if (attempted && statusCode >= 400 && statusCode < 500) {
      logService.audit(attempted, 'login_failed', attempted, {
        type: 'auth',
        reason: err.message,
        statusCode,
        ...ctx(req),
      });
    }
    next(err);
  }
};

exports.getProfile = async (req, res, next) => {
  try {
    const user = await userService.getProfile(req.user.id);
    res.json(user);
  } catch (err) {
    next(err);
  }
};

exports.updateProfile = async (req, res, next) => {
  try {
    const user = await userService.updateProfile(req.user.id, req.body || {});
    const submittedFields = Object.keys(req.body || {}).filter((k) => k !== 'password');
    logService.audit(req.user.email, 'update_profile', req.user.email, {
      type: 'user', adminId: req.user.id, submittedFields, ...ctx(req),
    });
    res.json(user);
  } catch (err) {
    next(err);
  }
};

exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body || {};
    const result = await userService.generatePasswordResetToken(email);

    if (result) {
      const { token, user } = result;
      const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:63342/Glycr/frontend/index.html'}?reset_token=${token}`;

      if (process.env.NODE_ENV !== 'production') {
        logger.info(`📧 Reset link for ${user.email}: ${resetLink}`);
      }
      // TODO: send via Nodemailer in production, using resetLink

      logService.audit(user.email, 'password_reset_requested', user.email, {
        type: 'auth', adminId: user._id, ...ctx(req),
      });
    } else {
      logger.warn('Password reset requested for unknown email', {
        email, ...ctx(req),
      });
    }

    res.json({ message: 'If that email exists, a reset link was sent.' });
  } catch (err) {
    next(err);
  }
};

exports.resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body || {};
    const user = await userService.resetPassword(token, newPassword);
    logService.audit(user.email, 'reset_password', user.email, {
      type: 'auth', adminId: user._id, ...ctx(req),
    });
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    next(err);
  }
};

exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    await userService.changePassword(req.user.id, currentPassword, newPassword);
    logService.audit(req.user.email, 'change_password', req.user.email, {
      type: 'auth', adminId: req.user.id, ...ctx(req),
    });
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    next(err);
  }
};

exports.deactivateAccount = async (req, res, next) => {
  try {
    const { password } = req.body || {};
    await userService.deactivateAccount(req.user.id, password);
    logService.audit(req.user.email, 'deactivate_account', req.user.email, {
      type: 'auth', adminId: req.user.id, ...ctx(req),
    });
    res.json({ message: 'Account deactivated' });
  } catch (err) {
    next(err);
  }
};

// Schedules the account for permanent deletion (30-day grace by default).
// The user can cancel by signing in before the deadline. The actual anonymize
// runs via cron — see jobs/processScheduledDeletions.js.
exports.deleteAccount = async (req, res, next) => {
  try {
    const { password, confirm } = req.body || {};
    const result = await userService.deleteAccount(req.user.id, password, confirm);
    logService.audit(req.user.email, 'delete_account_scheduled', req.user.email, {
      type: 'danger', adminId: req.user.id,
      scheduledFor: result.scheduledFor,
      ...ctx(req),
    });
    res.json(result);   // { scheduledFor, graceDays }
  } catch (err) {
    next(err);
  }
};
