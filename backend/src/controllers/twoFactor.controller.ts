import { Response } from 'express';
import { authenticator } from 'otplib';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { AuthRequest } from '../middleware/auth';
import { User } from '../models/User';
import { AppError } from '../utils/AppError';
import asyncHandler from '../utils/asyncHandler';
import { recordSecurityEvent } from '../utils/securityEvents';
import { hashToken } from '../utils/tokens';

const APP_NAME = 'Pulse';

function generateBackupCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(5).toString('hex')); // 10 hex chars
  }
  return codes;
}

/** Start 2FA setup — returns secret + otpauth URL (user must verify to enable) */
export const setup2FA = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.userId).select('+twoFactorSecret');
  if (!user) throw new AppError('User not found', 404);
  if (user.twoFactorEnabled) {
    throw new AppError('2FA is already enabled', 400, '2FA_ALREADY_ON');
  }
  // Optional: require verified email
  if (req.query.requireEmail === '1' && !user.isEmailVerified) {
    throw new AppError('Verify your email before enabling 2FA', 400, 'EMAIL_REQUIRED');
  }

  // Reuse existing pending secret so Safari reload / re-tap Setup does not orphan Authenticator
  let secret = user.twoFactorSecret || '';
  if (!secret) {
    secret = authenticator.generateSecret();
    user.twoFactorSecret = secret;
    user.twoFactorEnabled = false;
    await user.save();
  }

  const otpauth = authenticator.keyuri(user.email || user.username, APP_NAME, secret);

  res.json({
    success: true,
    data: {
      secret,
      otpauth,
      // Client can render QR from otpauth
      message: 'Scan with your authenticator app, then confirm with a code',
    },
  });
});

/** Confirm TOTP and enable 2FA — returns one-time backup codes */
export const enable2FA = asyncHandler(async (req: AuthRequest, res: Response) => {
  const code = String(req.body.code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) {
    throw new AppError('Enter the 6-digit code from your app', 400, 'INVALID_CODE');
  }

  const user = await User.findById(req.userId).select('+twoFactorSecret +twoFactorBackupCodes');
  if (!user) throw new AppError('User not found', 404);
  if (!user.twoFactorSecret) {
    throw new AppError('Start 2FA setup first', 400, '2FA_NOT_STARTED');
  }

  const valid = authenticator.verify({ token: code, secret: user.twoFactorSecret });
  if (!valid) {
    recordSecurityEvent('2fa_failed', { userId: req.userId, ip: req.ip });
    throw new AppError('Invalid authenticator code', 400, 'INVALID_CODE');
  }

  const plainCodes = generateBackupCodes(8);
  const hashed = await Promise.all(plainCodes.map((c) => bcrypt.hash(c, 10)));

  user.twoFactorEnabled = true;
  user.twoFactorBackupCodes = hashed;
  await user.save();

  recordSecurityEvent('2fa_enabled', { userId: req.userId, ip: req.ip });

  res.json({
    success: true,
    data: {
      enabled: true,
      backupCodes: plainCodes,
      message: 'Save these backup codes — they will not be shown again',
    },
  });
});

/** Disable 2FA with password + TOTP or backup code */
export const disable2FA = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { password, code } = req.body;
  const user = await User.findById(req.userId).select(
    '+password +twoFactorSecret +twoFactorBackupCodes'
  );
  if (!user) throw new AppError('User not found', 404);
  if (!user.twoFactorEnabled) {
    throw new AppError('2FA is not enabled', 400, '2FA_OFF');
  }
  if (!(await user.comparePassword(String(password || '')))) {
    throw new AppError('Current password is incorrect', 400, 'INVALID_PASSWORD');
  }

  const token = String(code || '').replace(/\s/g, '');
  let ok = false;
  if (/^\d{6}$/.test(token) && user.twoFactorSecret) {
    ok = authenticator.verify({ token, secret: user.twoFactorSecret });
  }
  if (!ok && token && user.twoFactorBackupCodes?.length) {
    for (let i = 0; i < user.twoFactorBackupCodes.length; i++) {
      if (await bcrypt.compare(token, user.twoFactorBackupCodes[i])) {
        ok = true;
        user.twoFactorBackupCodes.splice(i, 1);
        break;
      }
    }
  }
  if (!ok) {
    recordSecurityEvent('2fa_failed', { userId: req.userId, ip: req.ip });
    throw new AppError('Invalid 2FA or backup code', 400, 'INVALID_CODE');
  }

  user.twoFactorEnabled = false;
  user.twoFactorSecret = '';
  user.twoFactorBackupCodes = [];
  await user.save();

  recordSecurityEvent('2fa_disabled', { userId: req.userId, ip: req.ip });

  res.json({ success: true, data: { enabled: false } });
});

export const get2FAStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.userId).select(
    'twoFactorEnabled isEmailVerified +twoFactorSecret'
  );
  if (!user) throw new AppError('User not found', 404);
  const pendingSetup =
    !user.twoFactorEnabled && !!(user.twoFactorSecret && user.twoFactorSecret.length > 0);
  res.json({
    success: true,
    data: {
      enabled: !!user.twoFactorEnabled,
      emailVerified: !!user.isEmailVerified,
      /** Setup started but not confirmed — Safari may reload when switching to Authenticator */
      pendingSetup,
    },
  });
});

/**
 * Resume an incomplete 2FA setup (secret already stored, not yet enabled).
 * Needed on mobile: switching to Google Authenticator often reloads Safari and
 * drops in-memory setup UI; the secret remains on the server until enable/cancel.
 */
export const resume2FASetup = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.userId).select(
    '+twoFactorSecret twoFactorEnabled email username'
  );
  if (!user) throw new AppError('User not found', 404);
  if (user.twoFactorEnabled) {
    throw new AppError('2FA is already enabled', 400, '2FA_ALREADY_ON');
  }
  if (!user.twoFactorSecret) {
    throw new AppError('No pending 2FA setup', 404, '2FA_NOT_STARTED');
  }
  const secret = user.twoFactorSecret;
  const otpauth = authenticator.keyuri(user.email || user.username, APP_NAME, secret);
  res.json({
    success: true,
    data: {
      secret,
      otpauth,
      pendingSetup: true,
      message: 'Continue setup — enter a code from your authenticator app',
    },
  });
});

/** Abort incomplete setup (clears secret; does nothing if already enabled) */
export const cancel2FASetup = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.userId).select('+twoFactorSecret twoFactorEnabled');
  if (!user) throw new AppError('User not found', 404);
  if (user.twoFactorEnabled) {
    throw new AppError('Disable 2FA instead of canceling setup', 400, '2FA_ALREADY_ON');
  }
  user.twoFactorSecret = '';
  await user.save();
  res.json({ success: true, data: { pendingSetup: false } });
});

/** Used by login flow after password succeeds */
export async function verifyUser2FA(
  userId: string,
  code: string
): Promise<{ ok: boolean; usedBackup?: boolean }> {
  const user = await User.findById(userId).select(
    '+twoFactorSecret +twoFactorBackupCodes twoFactorEnabled'
  );
  if (!user?.twoFactorEnabled) return { ok: true };
  const token = String(code || '').replace(/\s/g, '');
  if (/^\d{6}$/.test(token) && user.twoFactorSecret) {
    if (authenticator.verify({ token, secret: user.twoFactorSecret })) {
      return { ok: true };
    }
  }
  if (token && user.twoFactorBackupCodes?.length) {
    for (let i = 0; i < user.twoFactorBackupCodes.length; i++) {
      if (await bcrypt.compare(token, user.twoFactorBackupCodes[i])) {
        user.twoFactorBackupCodes.splice(i, 1);
        await user.save();
        return { ok: true, usedBackup: true };
      }
    }
  }
  return { ok: false };
}

// silence unused import if tree-shaken
void hashToken;
