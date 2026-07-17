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
