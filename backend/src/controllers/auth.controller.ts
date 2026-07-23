import { Response } from 'express';
import bcrypt from 'bcryptjs';
import { AuthRequest } from '../middleware/auth';
import { User } from '../models/User';
import { Session } from '../models/Session';
import { AppError } from '../utils/AppError';
import asyncHandler from '../utils/asyncHandler';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  generateRandomToken,
} from '../utils/tokens';
import { sendVerificationEmail, sendPasswordResetEmail } from '../services/email.service';
import config from '../config';
import { validatePasswordStrength, DUMMY_BCRYPT_HASH } from '../utils/passwordPolicy';
import { recordSecurityEvent } from '../utils/securityEvents';
import { verifyUser2FA } from './twoFactor.controller';
import crypto from 'crypto';

const REFRESH_COOKIE = 'refreshToken';
const ACCESS_COOKIE = 'accessToken';
const MAX_FAILED_LOGINS = 8;
const LOCK_MS = 15 * 60 * 1000;
/** Pending 2FA challenges (password OK, awaiting TOTP) — short-lived */
const pending2FA = new Map<
  string,
  { userId: string; exp: number; ip: string; userAgent: string }
>();

function cookieOptions(maxAgeMs: number) {
  // Prefer Lax to reduce CSRF; cross-site cookie auth is not used (Bearer-only API).
  // Secure cookies when COOKIE_SECURE=true (HTTPS deployments).
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax' as const,
    maxAge: maxAgeMs,
    path: '/',
  };
}

function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(ACCESS_COOKIE, accessToken, cookieOptions(15 * 60 * 1000));
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(7 * 24 * 60 * 60 * 1000));
}

function clearAuthCookies(res: Response) {
  const base = {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax' as const,
  };
  res.clearCookie(ACCESS_COOKIE, base);
  res.clearCookie(REFRESH_COOKIE, base);
}

async function createSession(
  userId: string,
  refreshToken: string,
  req: AuthRequest
): Promise<string> {
  const { clientIp } = await import('../utils/sessionInfo');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const session = await Session.create({
    user: userId,
    refreshTokenHash: hashToken(refreshToken),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
    ip: clientIp(req).slice(0, 64),
    expiresAt,
    isValid: true,
    lastActiveAt: new Date(),
  });
  return session._id.toString();
}

export const register = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { username, email, password, displayName } = req.body;

  const pw = validatePasswordStrength(password, { email, username });
  if (!pw.ok) {
    throw new AppError(pw.errors[0] || 'Weak password', 400, 'WEAK_PASSWORD');
  }

  const existing = await User.findOne({
    $or: [{ email }, { username }],
  });
  if (existing) {
    // Generic message — avoid account enumeration (email vs username)
    throw new AppError('An account with those details already exists', 409, 'DUPLICATE');
  }

  const verificationToken = generateRandomToken();
  const user = await User.create({
    username,
    email,
    password,
    displayName: displayName || username,
    emailVerificationToken: hashToken(verificationToken),
    emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  // Never fail registration after the user row exists (would orphan account → 409 on retry).
  // SMTP is often unset on first Docker/tunnel deploys; account still works without email.
  let verificationEmailSent = true;
  try {
    await sendVerificationEmail(email, verificationToken, user.displayName);
  } catch (err) {
    verificationEmailSent = false;
    const { default: logger } = await import('../utils/logger');
    logger.warn('Verification email skipped after register', {
      userId: user._id.toString(),
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Temporary session id for signing - create session properly
  const tempRefresh = signRefreshToken(user._id.toString(), 'pending');
  const sessionId = await createSession(user._id.toString(), tempRefresh, req);
  const accessToken = signAccessToken(user._id.toString(), sessionId);
  const refreshToken = signRefreshToken(user._id.toString(), sessionId);

  await Session.findByIdAndUpdate(sessionId, {
    refreshTokenHash: hashToken(refreshToken),
  });

  setAuthCookies(res, accessToken, refreshToken);

  res.status(201).json({
    success: true,
    data: {
      user: user.toPublicJSON(),
      accessToken,
      refreshToken,
      verificationEmailSent,
      ...(verificationEmailSent
        ? {}
        : {
            message:
              'Account created. Email verification could not be sent (mail not configured) — you can still sign in.',
          }),
    },
  });
});

export const login = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { emailOrUsername, password, twoFactorCode } = req.body;
  const identifier = emailOrUsername.toLowerCase().trim();
  const ip = req.ip || '';
  const ua = String(req.headers['user-agent'] || '');

  const user = await User.findOne({
    $or: [{ email: identifier }, { username: identifier }],
  }).select('+password +twoFactorSecret +twoFactorBackupCodes');

  // Constant-time-ish: always run a bcrypt compare to reduce user-enumeration via timing
  if (!user) {
    await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
    recordSecurityEvent('login_failed', { ip, userAgent: ua });
    throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
  }

  if (user.isLocked()) {
    recordSecurityEvent('login_locked', { userId: user._id.toString(), ip });
    throw new AppError(
      'Account temporarily locked due to failed logins. Try again later.',
      423,
      'ACCOUNT_LOCKED'
    );
  }

  if (!(await user.comparePassword(password))) {
    user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
    if (user.failedLoginAttempts >= MAX_FAILED_LOGINS) {
      user.lockUntil = new Date(Date.now() + LOCK_MS);
      user.failedLoginAttempts = 0;
      recordSecurityEvent('login_locked', { userId: user._id.toString(), ip });
    }
    await user.save();
    recordSecurityEvent('login_failed', { userId: user._id.toString(), ip, userAgent: ua });
    throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
  }

  // Optional 2FA — never compulsory; only if user enabled it
  if (user.twoFactorEnabled) {
    if (!twoFactorCode) {
      const challengeId = crypto.randomBytes(24).toString('hex');
      pending2FA.set(challengeId, {
        userId: user._id.toString(),
        exp: Date.now() + 5 * 60 * 1000,
        ip,
        userAgent: ua,
      });
      // GC old challenges
      for (const [k, v] of pending2FA) {
        if (v.exp < Date.now()) pending2FA.delete(k);
      }
      res.json({
        success: true,
        data: {
          requires2FA: true,
          challengeId,
          message: 'Enter your authenticator code',
        },
      });
      return;
    }
    const check = await verifyUser2FA(user._id.toString(), String(twoFactorCode));
    if (!check.ok) {
      recordSecurityEvent('2fa_failed', { userId: user._id.toString(), ip });
      throw new AppError('Invalid two-factor code', 401, 'INVALID_2FA');
    }
  }

  // Suspicious login / impossible-travel heuristic (IP change + short interval)
  const prevIp = (user.lastLoginIp || '').trim();
  const prevAt = user.lastLoginAt ? new Date(user.lastLoginAt).getTime() : 0;
  if (prevIp && ip && prevIp !== ip.slice(0, 64) && prevAt) {
    const minutes = (Date.now() - prevAt) / 60000;
    if (minutes < 60) {
      recordSecurityEvent('impossible_travel', {
        userId: user._id.toString(),
        ip,
        meta: { previousIp: prevIp.slice(0, 64), minutesSinceLast: Math.round(minutes) },
      });
    } else {
      recordSecurityEvent('suspicious_ip', {
        userId: user._id.toString(),
        ip,
        meta: { previousIp: prevIp.slice(0, 64) },
      });
    }
  }

  // Reset lockout counters
  user.failedLoginAttempts = 0;
  user.lockUntil = undefined;
  user.isOnline = true;
  user.lastSeen = new Date();
  user.lastLoginAt = new Date();
  user.lastLoginIp = ip.slice(0, 64);
  await user.save();

  const tempRefresh = signRefreshToken(user._id.toString(), 'pending');
  const sessionId = await createSession(user._id.toString(), tempRefresh, req);
  const accessToken = signAccessToken(user._id.toString(), sessionId);
  const refreshToken = signRefreshToken(user._id.toString(), sessionId);

  await Session.findByIdAndUpdate(sessionId, {
    refreshTokenHash: hashToken(refreshToken),
  });

  setAuthCookies(res, accessToken, refreshToken);
  recordSecurityEvent('login_success', { userId: user._id.toString(), ip, userAgent: ua });

  res.json({
    success: true,
    data: {
      user: user.toPublicJSON(),
      accessToken,
      refreshToken,
    },
  });
});

/** Complete login after 2FA challenge */
export const login2FA = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { challengeId, code } = req.body;
  const pending = pending2FA.get(String(challengeId || ''));
  if (!pending || pending.exp < Date.now()) {
    throw new AppError('2FA challenge expired — sign in again', 401, '2FA_EXPIRED');
  }
  const check = await verifyUser2FA(pending.userId, String(code || ''));
  if (!check.ok) {
    recordSecurityEvent('2fa_failed', { userId: pending.userId, ip: req.ip });
    throw new AppError('Invalid two-factor code', 401, 'INVALID_2FA');
  }
  pending2FA.delete(String(challengeId));

  const user = await User.findById(pending.userId);
  if (!user) throw new AppError('User not found', 404);

  user.failedLoginAttempts = 0;
  user.lockUntil = undefined;
  user.isOnline = true;
  user.lastSeen = new Date();
  user.lastLoginAt = new Date();
  user.lastLoginIp = (req.ip || '').slice(0, 64);
  await user.save();

  const tempRefresh = signRefreshToken(user._id.toString(), 'pending');
  const sessionId = await createSession(user._id.toString(), tempRefresh, req);
  const accessToken = signAccessToken(user._id.toString(), sessionId);
  const refreshToken = signRefreshToken(user._id.toString(), sessionId);
  await Session.findByIdAndUpdate(sessionId, {
    refreshTokenHash: hashToken(refreshToken),
  });
  setAuthCookies(res, accessToken, refreshToken);
  recordSecurityEvent('login_success', {
    userId: user._id.toString(),
    ip: req.ip,
    meta: { via: '2fa' },
  });

  res.json({
    success: true,
    data: {
      user: user.toPublicJSON(),
      accessToken,
      refreshToken,
    },
  });
});

export const refresh = asyncHandler(async (req: AuthRequest, res: Response) => {
  const token = req.body.refreshToken || req.cookies?.refreshToken;
  if (!token || typeof token !== 'string' || token.length > 4096) {
    throw new AppError('Refresh token required', 401, 'NO_REFRESH_TOKEN');
  }

  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH');
  }

  const tokenHash = hashToken(token);
  // Atomic rotate: only one concurrent refresh wins with this hash
  const accessToken = signAccessToken(payload.userId, payload.sessionId);
  const refreshToken = signRefreshToken(payload.userId, payload.sessionId);
  const newHash = hashToken(refreshToken);
  const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const { clientIp } = await import('../utils/sessionInfo');
  const session = await Session.findOneAndUpdate(
    {
      _id: payload.sessionId,
      user: payload.userId,
      isValid: true,
      refreshTokenHash: tokenHash,
      expiresAt: { $gt: new Date() },
    },
    {
      $set: {
        refreshTokenHash: newHash,
        lastActiveAt: new Date(),
        expiresAt: newExpiry,
        // Keep metadata current when the same session moves network / browser updates
        userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
        ip: clientIp(req).slice(0, 64),
      },
    },
    { new: true }
  );

  if (!session) {
    // Possible reuse of rotated token → revoke session
    await Session.updateOne(
      { _id: payload.sessionId, user: payload.userId },
      { $set: { isValid: false } }
    );
    throw new AppError('Session revoked', 401, 'SESSION_REVOKED');
  }

  setAuthCookies(res, accessToken, refreshToken);

  const user = await User.findById(payload.userId);
  res.json({
    success: true,
    data: {
      accessToken,
      refreshToken,
      user: user?.toPublicJSON(),
    },
  });
});

export const logout = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (req.sessionId) {
    await Session.findByIdAndUpdate(req.sessionId, { isValid: false });
  }

  if (req.userId) {
    const activeSessions = await Session.countDocuments({
      user: req.userId,
      isValid: true,
    });
    if (activeSessions === 0) {
      await User.findByIdAndUpdate(req.userId, {
        isOnline: false,
        lastSeen: new Date(),
      });
    }
    // Drop live sockets for this session's user room when fully logged out
    try {
      const { getIO } = await import('../socket');
      if (activeSessions === 0) {
        getIO().in(`user:${req.userId}`).disconnectSockets(true);
      }
    } catch {
      /* socket may not be up in tests */
    }
  }

  clearAuthCookies(res);
  res.json({ success: true, data: { message: 'Logged out' } });
});

export const logoutEverywhere = asyncHandler(async (req: AuthRequest, res: Response) => {
  await Session.updateMany({ user: req.userId }, { isValid: false });
  await User.findByIdAndUpdate(req.userId, {
    isOnline: false,
    lastSeen: new Date(),
  });
  try {
    const { getIO } = await import('../socket');
    getIO().in(`user:${req.userId}`).disconnectSockets(true);
  } catch {
    /* */
  }
  clearAuthCookies(res);
  res.json({ success: true, data: { message: 'Logged out from all devices' } });
});

export const forgotPassword = asyncHandler(async (req: AuthRequest, res: Response) => {
  // Dev / tunnels: email reset is disabled — use authenticator reset instead
  if (config.env === 'development') {
    throw new AppError(
      'Email password reset is disabled in development. Use authenticator reset (2FA) instead.',
      403,
      'EMAIL_RESET_DISABLED'
    );
  }

  const { email } = req.body;
  const user = await User.findOne({ email: String(email || '').toLowerCase().trim() });

  // Always return a quick success response to prevent email enumeration.
  // Never block the HTTP response on SMTP.
  if (user) {
    const token = generateRandomToken();
    user.passwordResetToken = hashToken(token);
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();

    void sendPasswordResetEmail(email, token, user.displayName).catch((err) => {
      recordSecurityEvent('password_reset', {
        userId: user._id.toString(),
        ip: req.ip,
        meta: { stage: 'email_failed', err: String(err?.message || err).slice(0, 80) },
      });
    });
  }

  res.json({
    success: true,
    data: {
      message: 'If that email exists, a reset link has been sent',
    },
  });
});

export const resetPassword = asyncHandler(async (req: AuthRequest, res: Response) => {
  // Token-from-email reset is paired with forgot-password — also off in development
  if (config.env === 'development') {
    throw new AppError(
      'Email password reset is disabled in development. Use authenticator reset (2FA) instead.',
      403,
      'EMAIL_RESET_DISABLED'
    );
  }

  const { token, password } = req.body;
  if (!token || typeof token !== 'string' || token.length > 256) {
    throw new AppError('Invalid or expired reset token', 400, 'INVALID_TOKEN');
  }

  const pw = validatePasswordStrength(password);
  if (!pw.ok) {
    throw new AppError(pw.errors[0] || 'Weak password', 400, 'WEAK_PASSWORD');
  }

  const user = await User.findOne({
    passwordResetToken: hashToken(token),
    passwordResetExpires: { $gt: new Date() },
  }).select('+passwordResetToken +passwordResetExpires +password');

  if (!user) throw new AppError('Invalid or expired reset token', 400, 'INVALID_TOKEN');

  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  user.failedLoginAttempts = 0;
  user.lockUntil = undefined;
  await user.save();

  recordSecurityEvent('password_reset', { userId: user._id.toString(), ip: req.ip });

  // Don't block the response on session cleanup
  void Session.updateMany({ user: user._id }, { isValid: false }).catch(() => undefined);
  try {
    const { getIO } = await import('../socket');
    getIO().in(`user:${user._id}`).disconnectSockets(true);
  } catch {
    /* */
  }

  res.json({ success: true, data: { message: 'Password reset successful' } });
});

/**
 * Reset password with Google Authenticator / TOTP (or a backup code).
 * Only available when the account already has 2FA enabled — never for accounts without 2FA.
 */
export const resetPasswordWith2FA = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { emailOrUsername, code, password } = req.body;
  const identifier = String(emailOrUsername || '')
    .toLowerCase()
    .trim();
  const ip = req.ip || '';

  const pw = validatePasswordStrength(password);
  if (!pw.ok) {
    throw new AppError(pw.errors[0] || 'Weak password', 400, 'WEAK_PASSWORD');
  }

  // Timing equalization for unknown users
  const user = await User.findOne({
    $or: [{ email: identifier }, { username: identifier }],
  }).select('+password +twoFactorSecret +twoFactorBackupCodes twoFactorEnabled');

  if (!user || !user.twoFactorEnabled) {
    // Same message whether missing user or no 2FA — avoid account enumeration
    await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
    recordSecurityEvent('login_failed', {
      ip,
      meta: { via: 'reset_2fa', reason: 'no_2fa_or_user' },
    });
    throw new AppError(
      'Authenticator reset is only available for accounts with 2FA turned on',
      400,
      '2FA_RESET_UNAVAILABLE'
    );
  }

  if (user.isLocked()) {
    throw new AppError(
      'Account temporarily locked due to failed attempts. Try again later.',
      423,
      'ACCOUNT_LOCKED'
    );
  }

  const { verifyUser2FA } = await import('./twoFactor.controller');
  const check = await verifyUser2FA(user._id.toString(), String(code || ''));
  if (!check.ok) {
    user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
    if (user.failedLoginAttempts >= MAX_FAILED_LOGINS) {
      user.lockUntil = new Date(Date.now() + LOCK_MS);
      user.failedLoginAttempts = 0;
      recordSecurityEvent('login_locked', { userId: user._id.toString(), ip });
    }
    await user.save();
    recordSecurityEvent('2fa_failed', {
      userId: user._id.toString(),
      ip,
      meta: { via: 'reset_2fa' },
    });
    // 400 not 401 — avoids client treating this as "session expired" / refresh loop
    throw new AppError('Invalid authenticator or backup code', 400, 'INVALID_2FA');
  }

  user.password = password;
  user.failedLoginAttempts = 0;
  user.lockUntil = undefined;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  recordSecurityEvent('password_reset', {
    userId: user._id.toString(),
    ip,
    meta: { via: '2fa' },
  });

  // Respond first — session cleanup must not leave the client spinner running
  res.json({
    success: true,
    data: {
      message: 'Password reset successful. Sign in with your new password.',
    },
  });

  void Session.updateMany({ user: user._id }, { isValid: false }).catch(() => undefined);
  try {
    const { getIO } = await import('../socket');
    getIO().in(`user:${user._id}`).disconnectSockets(true);
  } catch {
    /* */
  }
});

export const verifyEmail = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { token } = req.body;
  const user = await User.findOne({
    emailVerificationToken: hashToken(token),
    emailVerificationExpires: { $gt: new Date() },
  }).select('+emailVerificationToken +emailVerificationExpires');

  if (!user) throw new AppError('Invalid or expired verification token', 400, 'INVALID_TOKEN');

  user.isEmailVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpires = undefined;
  await user.save();

  res.json({ success: true, data: { message: 'Email verified', user: user.toPublicJSON() } });
});

export const resendVerification = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.userId);
  if (!user) throw new AppError('User not found', 404);
  if (user.isEmailVerified) {
    throw new AppError('Email already verified', 400, 'ALREADY_VERIFIED');
  }

  const token = generateRandomToken();
  user.emailVerificationToken = hashToken(token);
  user.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await user.save();
  try {
    await sendVerificationEmail(user.email, token, user.displayName);
  } catch {
    throw new AppError(
      'Could not send verification email. Mail is not configured on this server.',
      503,
      'EMAIL_UNAVAILABLE'
    );
  }

  res.json({ success: true, data: { message: 'Verification email sent' } });
});

export const me = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.userId);
  if (!user) throw new AppError('User not found', 404);
  res.json({ success: true, data: { user: user.toPublicJSON() } });
});

export const getSessions = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { parseUserAgent, normalizeIp, activityState, clientIp } = await import(
    '../utils/sessionInfo'
  );

  // Touch current session so "Active now" is accurate for this request
  if (req.sessionId) {
    await Session.updateOne(
      { _id: req.sessionId, user: req.userId, isValid: true },
      {
        $set: {
          lastActiveAt: new Date(),
          userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
          ip: clientIp(req).slice(0, 64),
        },
      }
    ).catch(() => undefined);
  }

  const sessions = await Session.find({
    user: req.userId,
    isValid: true,
    expiresAt: { $gt: new Date() },
  })
    .sort({ lastActiveAt: -1 })
    .select('-refreshTokenHash')
    .lean();

  res.json({
    success: true,
    data: {
      sessions: sessions.map((s) => {
        const id = String(s._id);
        const ua = String(s.userAgent || '');
        const device = parseUserAgent(ua);
        const lastActiveAt = s.lastActiveAt || s.createdAt;
        const activity = activityState(lastActiveAt);
        return {
          id,
          userAgent: ua,
          ip: normalizeIp(String(s.ip || '')),
          /** Raw stored IP (may be IPv6-mapped) */
          ipRaw: s.ip || '',
          lastActiveAt,
          createdAt: s.createdAt,
          expiresAt: s.expiresAt,
          current: id === req.sessionId,
          device,
          isOnline: activity.isOnline || id === req.sessionId,
          activityLabel:
            id === req.sessionId ? 'Active now' : activity.relative,
        };
      }),
    },
  });
});

export const revokeSession = asyncHandler(async (req: AuthRequest, res: Response) => {
  const session = await Session.findOne({
    _id: req.params.sessionId,
    user: req.userId,
  });
  if (!session) throw new AppError('Session not found', 404);
  session.isValid = false;
  await session.save();

  // Kill live sockets for this session (HTTP already rejects on next request)
  try {
    const { getIO } = await import('../socket');
    const io = getIO();
    const sockets = await io.in(`user:${req.userId}`).fetchSockets();
    const revokedId = session._id.toString();
    for (const s of sockets) {
      const sid =
        (s.data as { sessionId?: string })?.sessionId ||
        (s as unknown as { sessionId?: string }).sessionId;
      if (sid === revokedId) s.disconnect(true);
    }
  } catch {
    /* */
  }

  res.json({ success: true, data: { message: 'Session revoked' } });
});
