import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const env = process.env.NODE_ENV || 'development';
const required = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'MONGODB_URI'];

for (const key of required) {
  if (!process.env[key]) {
    if (env === 'production') {
      console.error(`[config] FATAL: Missing env ${key}`);
      process.exit(1);
    }
    console.warn(`[config] Missing env: ${key}`);
  }
}

const accessSecret =
  process.env.JWT_ACCESS_SECRET || 'dev_access_secret_change_in_production_32';
const refreshSecret =
  process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret_change_in_production_32';

if (env === 'production') {
  if (accessSecret.length < 32 || refreshSecret.length < 32) {
    console.error('[config] FATAL: JWT secrets must be at least 32 characters in production');
    process.exit(1);
  }
  if (accessSecret.startsWith('dev_') || refreshSecret.startsWith('dev_')) {
    console.error('[config] FATAL: Default dev JWT secrets cannot be used in production');
    process.exit(1);
  }
  const weak = /change_me|your_access_secret|your_refresh_secret|placeholder/i;
  if (weak.test(accessSecret) || weak.test(refreshSecret)) {
    console.error('[config] FATAL: Placeholder JWT secrets cannot be used in production');
    process.exit(1);
  }
  if ((process.env.CORS_ORIGINS || '').includes('*')) {
    console.error('[config] FATAL: CORS_ORIGINS cannot include * in production');
    process.exit(1);
  }
  // Prefer dedicated media HMAC secret so JWT rotation doesn't re-issue old media URLs
  if (!process.env.MEDIA_SIGNING_SECRET || process.env.MEDIA_SIGNING_SECRET.length < 32) {
    console.warn(
      '[config] WARN: Set MEDIA_SIGNING_SECRET (≥32 chars) in production — currently falling back to JWT access secret'
    );
  }
  if (!process.env.MALWARE_SCAN_CMD?.trim()) {
    console.warn(
      '[config] WARN: MALWARE_SCAN_CMD is unset — uploads are not scanned. Set it in production for higher security.'
    );
  }
}

export const config = {
  env,
  port: parseInt(process.env.PORT || '5050', 10),
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/pulse',
  jwt: {
    accessSecret,
    refreshSecret,
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES || '7d',
  },
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  apiUrl: process.env.API_URL || 'http://localhost:5050',
  corsOrigins: (process.env.CORS_ORIGINS || process.env.CLIENT_URL || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  uploadDir: process.env.UPLOAD_DIR || path.resolve(__dirname, '../../../uploads'),
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800', 10),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || 'Pulse <noreply@pulse.app>',
  },
  // Secure cookies in production by default (override with COOKIE_SECURE=false for local HTTPS off)
  cookieSecure:
    process.env.COOKIE_SECURE === 'true' ||
    (env === 'production' && process.env.COOKIE_SECURE !== 'false'),
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    // Global API ceiling (per IP) — high for tunnels where many users share an egress IP
    max: parseInt(
      process.env.RATE_LIMIT_MAX || (env === 'development' ? '3000' : '800'),
      10
    ),
    // Failed auth attempts per IP (or IP+account) per window
    authMax: parseInt(
      process.env.AUTH_RATE_LIMIT_MAX || (env === 'development' ? '200' : '40'),
      10
    ),
  },
};

export default config;
