import { z } from 'zod';

export const registerSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores')
    .transform((s) => s.toLowerCase()),
  email: z.string().email().transform((s) => s.toLowerCase()),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(72, 'Password must be at most 72 characters') // bcrypt effective limit
    .regex(/[A-Za-z]/, 'Password must contain a letter')
    .regex(/[0-9]/, 'Password must contain a number'),
  displayName: z.string().min(1).max(64).optional(),
});

export const loginSchema = z.object({
  emailOrUsername: z.string().min(1).max(128),
  // Cap length to avoid bcrypt DoS on huge payloads
  password: z.string().min(1).max(128),
  /** Optional TOTP / backup code when 2FA is enabled */
  twoFactorCode: z.string().max(32).optional(),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase()),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1).max(256),
  password: z
    .string()
    .min(8)
    .max(72)
    .regex(/[A-Za-z]/)
    .regex(/[0-9]/),
});

/** Password reset using TOTP — only for accounts with 2FA already enabled */
export const resetPassword2FASchema = z.object({
  emailOrUsername: z.string().min(1).max(128),
  code: z.string().min(4).max(32),
  password: z
    .string()
    .min(8)
    .max(72)
    .regex(/[A-Za-z]/)
    .regex(/[0-9]/),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1).max(256),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z
    .string()
    .min(8)
    .max(72)
    .regex(/[A-Za-z]/)
    .regex(/[0-9]/),
});
