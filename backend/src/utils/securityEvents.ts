/**
 * Lightweight security event log (in-memory + logger).
 * Never logs passwords, tokens, keys, or message plaintext.
 */
import logger from './logger';

export type SecurityEventType =
  | 'login_success'
  | 'login_failed'
  | 'login_locked'
  | '2fa_failed'
  | '2fa_enabled'
  | '2fa_disabled'
  | 'password_changed'
  | 'password_reset'
  | 'session_revoked'
  | 'suspicious_ip'
  | 'impossible_travel'
  | 'unusual_activity'
  | 'account_report'
  | 'malware_blocked';

interface SecurityEvent {
  type: SecurityEventType;
  userId?: string;
  ip?: string;
  userAgent?: string;
  meta?: Record<string, string | number | boolean>;
  at: string;
}

const recent: SecurityEvent[] = [];
const MAX = 500;

/** Track failed logins per IP for flood detection */
const ipFails = new Map<string, { count: number; first: number }>();

export function recordSecurityEvent(
  type: SecurityEventType,
  data: {
    userId?: string;
    ip?: string;
    userAgent?: string;
    meta?: Record<string, string | number | boolean>;
  } = {}
): void {
  const ev: SecurityEvent = {
    type,
    userId: data.userId,
    ip: data.ip ? String(data.ip).slice(0, 64) : undefined,
    userAgent: data.userAgent ? String(data.userAgent).slice(0, 200) : undefined,
    meta: data.meta,
    at: new Date().toISOString(),
  };
  recent.push(ev);
  if (recent.length > MAX) recent.shift();

  // Never include secrets in log lines
  logger.info(`[security] ${type}`, {
    userId: ev.userId,
    ip: ev.ip,
    meta: ev.meta,
  });

  if (type === 'login_failed' && ev.ip) {
    const cur = ipFails.get(ev.ip) || { count: 0, first: Date.now() };
    // Reset window every 15 minutes
    if (Date.now() - cur.first > 15 * 60 * 1000) {
      cur.count = 0;
      cur.first = Date.now();
    }
    cur.count += 1;
    ipFails.set(ev.ip, cur);
    if (cur.count >= 30) {
      logger.warn('[security] high failed-login volume from IP', {
        ip: ev.ip,
        count: cur.count,
      });
    }
  }
}

export function getRecentSecurityEvents(limit = 50): SecurityEvent[] {
  return recent.slice(-limit);
}

/** Redact sensitive fields from arbitrary objects before logging */
export function redactSecrets(input: unknown): unknown {
  if (input == null) return input;
  if (typeof input === 'string') {
    if (input.length > 40 && /^[A-Za-z0-9._~+/=-]{20,}$/.test(input)) {
      return '[redacted]';
    }
    if (input.startsWith('🔐e2e:')) return '[e2e-ciphertext]';
    return input;
  }
  if (Array.isArray(input)) return input.map(redactSecrets);
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (
        key.includes('password') ||
        key.includes('secret') ||
        key.includes('token') ||
        key.includes('authorization') ||
        key.includes('cookie') ||
        key.includes('private') ||
        key === 'pkcs8' ||
        key.includes('backupcode')
      ) {
        out[k] = '[redacted]';
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return input;
}
