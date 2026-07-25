/**
 * Structured logger.
 *
 * Production emits one JSON object per line so a log shipper (Loki, Datadog,
 * CloudWatch) can index fields without regex parsing. Development keeps the
 * human-readable single-line format.
 *
 * Every line carries the active request id when one is in scope, so a request
 * and everything it logged can be correlated after the fact.
 */
import { redactSecrets } from './securityEvents';
import { getRequestId } from './requestContext';

export type Level = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_WEIGHT: Record<Level, number> = {
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
};

function configuredLevel(): Level {
  const raw = String(process.env.LOG_LEVEL || '').toLowerCase();
  if (raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug') {
    return raw;
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

/** Resolved once — changing LOG_LEVEL requires a restart, like every other config value. */
const minWeight = LEVEL_WEIGHT[configuredLevel()];
const asJson = process.env.NODE_ENV === 'production' && process.env.LOG_FORMAT !== 'pretty';

/** Counts by level, surfaced on /api/metrics so error rate is observable. */
export const logCounters: Record<Level, number> = {
  error: 0,
  warn: 0,
  info: 0,
  debug: 0,
};

function log(level: Level, message: string, meta?: unknown): void {
  logCounters[level] += 1;
  if (LEVEL_WEIGHT[level] < minWeight) return;

  // Never log secrets / ciphertext / tokens
  const safeMeta = meta !== undefined ? redactSecrets(meta) : undefined;
  const requestId = getRequestId();
  const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  if (asJson) {
    write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg: message,
        ...(requestId ? { requestId } : {}),
        ...(safeMeta !== undefined ? { meta: safeMeta } : {}),
      })
    );
    return;
  }

  const ts = new Date().toISOString();
  const rid = requestId ? ` [${requestId}]` : '';
  write(`[${ts}] [${level.toUpperCase()}]${rid} ${message}`, safeMeta ?? '');
}

export const logger = {
  info: (msg: string, meta?: unknown) => log('info', msg, meta),
  warn: (msg: string, meta?: unknown) => log('warn', msg, meta),
  error: (msg: string, meta?: unknown) => log('error', msg, meta),
  debug: (msg: string, meta?: unknown) => log('debug', msg, meta),
};

export default logger;
