/**
 * Per-request correlation id, propagated through async work via AsyncLocalStorage.
 *
 * Lets any log line written while handling a request — including from services
 * several awaits deep — be tied back to that request without threading an id
 * through every function signature.
 */
import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';

interface RequestStore {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestStore>();

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Accept an inbound correlation id when it looks safe, otherwise mint one.
 * Untrusted header values are never echoed into logs unfiltered.
 */
export function normalizeRequestId(header: unknown): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(raw)) return raw;
  return crypto.randomUUID();
}
