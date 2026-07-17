/**
 * Password strength + common-password rejection (offline list).
 * Compatible with existing bcrypt hashing (max 72 chars).
 */

const COMMON = new Set(
  [
    'password',
    'password1',
    'password123',
    '12345678',
    '123456789',
    '1234567890',
    'qwerty123',
    'qwertyuiop',
    'iloveyou',
    'admin123',
    'welcome1',
    'letmein',
    'monkey123',
    'dragon123',
    'master123',
    'sunshine',
    'princess',
    'football',
    'baseball',
    'abc12345',
    'passw0rd',
    'changeme',
    'trustno1',
    'login123',
    'pulse123',
    'pulseapp',
    'password!',
    'p@ssw0rd',
    'p@ssword',
    'welcome123',
    'adminadmin',
    'rootroot',
    'testtest',
    'useruser',
    'default1',
  ].map((s) => s.toLowerCase())
);

export interface PasswordCheckResult {
  ok: boolean;
  score: number; // 0–4
  errors: string[];
  hints: string[];
}

export function scorePassword(password: string): number {
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score++;
  if (COMMON.has(password.toLowerCase())) score = Math.min(score, 1);
  return Math.min(4, score);
}

/** bcrypt work factor (cost). 12 is a solid production default in 2024–2026. */
export const BCRYPT_ROUNDS = Math.min(
  15,
  Math.max(10, parseInt(process.env.BCRYPT_ROUNDS || '12', 10) || 12)
);

/**
 * Pre-computed bcrypt hash of a random unguessable password.
 * Used only for dummy compares when the user does not exist (timing equalization).
 * Valid bcrypt $2a$12$ form so bcrypt.compare runs full work factor.
 */
export const DUMMY_BCRYPT_HASH =
  '$2a$12$jCJ6rlwdF28aNQZfDsPOdePcxyhkJjmn/nKcaWhYOQ.x5VHsBucSW';

export function validatePasswordStrength(
  password: string,
  context?: { email?: string; username?: string }
): PasswordCheckResult {
  const errors: string[] = [];
  const hints: string[] = [];

  if (password.length < 8) errors.push('Password must be at least 8 characters');
  if (password.length > 72) errors.push('Password must be at most 72 characters');
  if (!/[A-Za-z]/.test(password)) errors.push('Password must contain a letter');
  if (!/[0-9]/.test(password)) errors.push('Password must contain a number');
  // Require mixed case OR symbol for stronger policy (still allows older simple passwords via score)
  if (!/[A-Z]/.test(password) && !/[^A-Za-z0-9]/.test(password)) {
    hints.push('Add an uppercase letter or symbol for better security');
  }
  if (COMMON.has(password.toLowerCase())) {
    errors.push('This password is too common — choose something more unique');
  }
  if (context?.email) {
    const local = context.email.split('@')[0]?.toLowerCase();
    if (local && local.length >= 4 && password.toLowerCase().includes(local)) {
      errors.push('Password must not contain your email name');
    }
  }
  if (context?.username && password.toLowerCase().includes(context.username.toLowerCase())) {
    errors.push('Password must not contain your username');
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    hints.push('Add a symbol for a stronger password');
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password)) {
    hints.push('Mix upper and lower case letters');
  }

  const score = scorePassword(password);
  return { ok: errors.length === 0, score, errors, hints };
}
