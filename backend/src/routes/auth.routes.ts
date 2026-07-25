import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as authController from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  registerSchema,
  loginSchema,
  login2FASchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  resetPassword2FASchema,
  verifyEmailSchema,
} from '../validation/auth.schema';
import config from '../config';

const router = Router();

// IP-based brute-force protection on auth endpoints.
// Through Cloudflare tunnels many clients share one public IP, so limits must be
// higher in development and only count *failed* attempts.
const isDev = config.env === 'development';
const authLimiter = rateLimit({
  // Dev: 15 min window, higher ceiling; prod uses config
  windowMs: isDev ? 15 * 60 * 1000 : config.rateLimit.windowMs,
  max: isDev ? Math.max(config.rateLimit.authMax, 200) : config.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  // Don't burn the budget on successful logins / password resets
  skipSuccessfulRequests: true,
  // Explicit IP key (trust proxy is set in app.ts)
  keyGenerator: (req) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    // Soft per-account isolation so two users behind same NAT don't block each other as hard
    const id =
      typeof req.body?.emailOrUsername === 'string'
        ? req.body.emailOrUsername.toLowerCase().trim().slice(0, 64)
        : typeof req.body?.email === 'string'
          ? req.body.email.toLowerCase().trim().slice(0, 64)
          : '';
    return id ? `${ip}:${id}` : ip;
  },
  message: {
    success: false,
    error: {
      message: 'Too many failed attempts. Wait a few minutes and try again.',
      code: 'RATE_LIMIT',
    },
  },
});

// Refresh is hotter than login (multi-tab) — separate, higher ceiling
const refreshLimiter = rateLimit({
  windowMs: 60_000,
  max: isDev ? 180 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || 'unknown',
  message: {
    success: false,
    error: { message: 'Too many refresh attempts', code: 'RATE_LIMIT' },
  },
});

router.post('/register', authLimiter, validate(registerSchema), authController.register);
router.post('/login', authLimiter, validate(loginSchema), authController.login);
router.post('/login/2fa', authLimiter, validate(login2FASchema), authController.login2FA);
router.post('/refresh', refreshLimiter, authController.refresh);
router.post('/logout', authenticate, authController.logout);
router.post('/logout-everywhere', authenticate, authController.logoutEverywhere);
router.post(
  '/forgot-password',
  authLimiter,
  validate(forgotPasswordSchema),
  authController.forgotPassword
);
router.post(
  '/reset-password',
  authLimiter,
  validate(resetPasswordSchema),
  authController.resetPassword
);
// 2FA-only password reset (Authenticator / backup codes) — no email link required
router.post(
  '/reset-password-2fa',
  authLimiter,
  validate(resetPassword2FASchema),
  authController.resetPasswordWith2FA
);
router.post('/verify-email', validate(verifyEmailSchema), authController.verifyEmail);
router.post('/resend-verification', authenticate, authController.resendVerification);
router.get('/me', authenticate, authController.me);
router.get('/sessions', authenticate, authController.getSessions);
router.delete('/sessions/:sessionId', authenticate, authController.revokeSession);

// Optional 2FA (user-controlled — never compulsory)
import * as twoFactor from '../controllers/twoFactor.controller';
router.get('/2fa/status', authenticate, twoFactor.get2FAStatus);
router.get('/2fa/setup/pending', authenticate, twoFactor.resume2FASetup);
router.post('/2fa/setup', authenticate, twoFactor.setup2FA);
router.post('/2fa/setup/cancel', authenticate, twoFactor.cancel2FASetup);
router.post('/2fa/enable', authenticate, twoFactor.enable2FA);
router.post('/2fa/disable', authenticate, twoFactor.disable2FA);

export default router;
