const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { validate, registerSchema, loginSchema, deactivateSchema } = require('../middleware/validation');
const { authLimiter, resetLimiter, registerLimiter } = require('../middleware/rateLimit');
const auth = require('../middleware/auth');
const { loginSlowDown } = require('../middleware/slowDown');

// ── Register ──
router.post('/auth/register', validate(registerSchema), registerLimiter, authLimiter, authController.register);

// ── Login ──
router.post(
  '/auth/login', validate(loginSchema), loginSlowDown, authLimiter, authController.login);

// ── Authenticated: self profile ──
router.get('/auth/profile', auth, authController.getProfile);
router.put('/auth/profile', auth, authController.updateProfile);

// ── Forgot password ──
router.post('/auth/forgot-password', resetLimiter, authController.forgotPassword);

// ── Reset password ──
router.post('/auth/reset-password', resetLimiter, authController.resetPassword);

// ── Change password ──
router.post('/auth/change-password', auth, authLimiter, authController.changePassword);

// ── Deactivate own account ──
router.post('/auth/deactivate', auth, validate(deactivateSchema), authLimiter, authController.deactivateAccount);

// ── Schedule own account for permanent deletion (30-day grace) ──
// Password + explicit "DELETE" confirmation are both required. Signing in
// before the deadline cancels automatically. Cron anonymizes at the deadline.
// Rate-limited on req.user.email so a stolen session can't brute-force the
// password field.
router.delete('/auth/account', auth, authLimiter, authController.deleteAccount);

module.exports = router;
