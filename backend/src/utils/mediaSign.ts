import crypto from 'crypto';
import config from '../config';

/** HMAC key derived from JWT secret — dedicated env override supported */
function mediaSecret(): string {
  return process.env.MEDIA_SIGNING_SECRET || config.jwt.accessSecret;
}

/**
 * Sign a relative upload path so /uploads can require a valid signature.
 * Example: /uploads/images/uuid.jpg?exp=…&sig=…
 */
/** Default 2h — short enough to limit leaked URL abuse; clients re-sign via API */
export function signUploadPath(pathname: string, ttlSec = 2 * 3600): string {
  const pathOnly = String(pathname || '').split('?')[0];
  if (!pathOnly.startsWith('/uploads/')) return pathOnly;
  // Prevent path tricks
  if (pathOnly.includes('..') || pathOnly.includes('\\')) return pathOnly;
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = crypto
    .createHmac('sha256', mediaSecret())
    .update(`${pathOnly}:${exp}`)
    .digest('base64url');
  return `${pathOnly}?exp=${exp}&sig=${sig}`;
}

export function verifyUploadSignature(
  pathname: string,
  expRaw: string | undefined,
  sigRaw: string | undefined
): boolean {
  if (!expRaw || !sigRaw) return false;
  const pathOnly = pathname.split('?')[0];
  if (!pathOnly.startsWith('/uploads/') || pathOnly.includes('..')) return false;
  const exp = parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(sigRaw) || sigRaw.length > 128) return false;

  const expected = crypto
    .createHmac('sha256', mediaSecret())
    .update(`${pathOnly}:${exp}`)
    .digest('base64url');

  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(sigRaw);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Sign attachment/avatar fields on API payloads (non-destructive to DB). */
export function signMediaFields<T extends Record<string, unknown>>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj } as Record<string, unknown>;

  if (typeof out.avatar === 'string' && out.avatar.includes('/uploads/')) {
    out.avatar = signUploadPath(toPath(out.avatar));
  }
  if (typeof out.url === 'string' && out.url.includes('/uploads/')) {
    out.url = signUploadPath(toPath(out.url));
  }
  if (typeof out.thumbnailUrl === 'string' && out.thumbnailUrl.includes('/uploads/')) {
    out.thumbnailUrl = signUploadPath(toPath(out.thumbnailUrl));
  }
  if (Array.isArray(out.attachments)) {
    out.attachments = out.attachments.map((a) =>
      a && typeof a === 'object' ? signMediaFields(a as Record<string, unknown>) : a
    );
  }
  if (out.sender && typeof out.sender === 'object') {
    out.sender = signMediaFields(out.sender as Record<string, unknown>);
  }
  if (out.replyTo && typeof out.replyTo === 'object') {
    out.replyTo = signMediaFields(out.replyTo as Record<string, unknown>);
  }
  if (Array.isArray(out.participants)) {
    out.participants = out.participants.map((p) => {
      if (!p || typeof p !== 'object') return p;
      const part = { ...(p as Record<string, unknown>) };
      if (part.user && typeof part.user === 'object') {
        part.user = signMediaFields(part.user as Record<string, unknown>);
      }
      return part;
    });
  }
  if (out.lastMessage && typeof out.lastMessage === 'object') {
    out.lastMessage = signMediaFields(out.lastMessage as Record<string, unknown>);
  }
  // Conversation-level avatar
  if (typeof out.avatar === 'string' && (out as { type?: string }).type) {
    /* already handled */
  }
  return out as T;
}

function toPath(url: string): string {
  const s = String(url).trim();
  if (s.startsWith('/uploads/')) return s.split('?')[0];
  try {
    if (s.includes('://')) {
      const u = new URL(s);
      if (u.pathname.startsWith('/uploads/')) return u.pathname;
    }
  } catch {
    /* */
  }
  const idx = s.indexOf('/uploads/');
  if (idx >= 0) return s.slice(idx).split('?')[0];
  return s.split('?')[0];
}
