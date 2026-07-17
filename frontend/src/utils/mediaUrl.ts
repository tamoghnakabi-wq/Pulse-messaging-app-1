import { getApiBaseUrl } from '../services/api';

/**
 * Resolve avatar / attachment URLs so they work after ngrok restarts.
 * Backend stores relative paths like "/uploads/images/x.jpg".
 *
 * Security: only allow /uploads/ paths (optionally signed). Reject //evil,
 * javascript:, data:, and arbitrary external hosts to prevent tracking/XSS
 * via crafted avatar/attachment URLs.
 */
export function mediaUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  const s = url.trim();
  if (!s) return undefined;

  // Block dangerous schemes and protocol-relative URLs
  const lower = s.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('//')
  ) {
    return undefined;
  }

  // Absolute URL — only accept /uploads/ paths (rewrite to same-origin)
  if (s.startsWith('http://') || s.startsWith('https://')) {
    try {
      const u = new URL(s);
      if (!u.pathname.startsWith('/uploads/')) return undefined;
      if (u.pathname.includes('..')) return undefined;
      // Prefer same-origin (Vite proxy) so tunnel domain always matches
      return u.pathname + u.search;
    } catch {
      return undefined;
    }
  }

  // Relative path (may include ?exp=&sig= signed media query)
  if (s.startsWith('/uploads/')) {
    if (s.includes('..')) return undefined;
    const base = getApiBaseUrl();
    // Empty / same origin → use path as-is (proxied by Vite)
    if (!base || base === window.location.origin) return s;
    return `${base.replace(/\/$/, '')}${s}`;
  }

  // Reject other relative paths (e.g. /api/..., //host)
  return undefined;
}
