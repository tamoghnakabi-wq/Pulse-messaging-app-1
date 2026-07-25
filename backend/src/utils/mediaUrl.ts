/**
 * Media URLs must be path-relative so they survive ngrok domain changes.
 * e.g. "/uploads/images/uuid.jpg"  — never "https://xxxx.ngrok.../uploads/..."
 */

/** Convert any stored URL into a durable relative path. */
export function toRelativeMediaPath(url: string | undefined | null): string {
  if (!url) return '';
  const s = String(url).trim();
  if (!s) return '';

  // Already relative
  if (s.startsWith('/uploads/')) return s;

  // Absolute URL — extract /uploads/... path
  try {
    if (s.includes('://')) {
      const u = new URL(s);
      if (u.pathname.startsWith('/uploads/')) {
        return u.pathname + (u.search || '');
      }
      return u.pathname.startsWith('/') ? u.pathname : `/${u.pathname}`;
    }
  } catch {
    /* fall through */
  }

  // Loose match
  const idx = s.indexOf('/uploads/');
  if (idx >= 0) return s.slice(idx);

  return s;
}

/**
 * Best-effort delete of a previously stored upload (avatar / cover replaced).
 * Without this every profile-photo change orphans a file on disk forever.
 *
 * Resolves inside `config.uploadDir` and refuses anything that escapes it, so a
 * tampered DB value can never be turned into an arbitrary-file delete.
 */
export function deleteStoredUpload(storedPath: string | undefined | null): void {
  const relative = toRelativeMediaPath(storedPath).split('?')[0];
  if (!relative.startsWith('/uploads/')) return;
  if (relative.includes('..') || relative.includes('\0') || relative.includes('\\')) return;

  try {
    // Required lazily: this module is imported by model files at load time.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const { default: config } = require('../config') as { default: { uploadDir: string } };

    const root = path.resolve(config.uploadDir);
    const target = path.resolve(root, `.${relative.slice('/uploads'.length)}`);
    if (target !== root && !target.startsWith(root + path.sep)) return;
    fs.unlink(target, () => undefined);
  } catch {
    /* never fail a request because cleanup failed */
  }
}

/** Build absolute URL for outbound responses when a public API base is known. */
export function toPublicMediaUrl(relativeOrAbsolute: string, apiBase: string): string {
  const path = toRelativeMediaPath(relativeOrAbsolute);
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const base = (apiBase || '').replace(/\/$/, '');
  // Prefer relative in DB; for API consumers that need absolute, prefix base
  if (!base) return path;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
