/**
 * Token storage helpers.
 *
 * Access tokens stay **in memory only** (not localStorage) so a stored XSS payload
 * cannot permanently harvest long-lived access tokens after reload — the page must
 * refresh via the refresh token first.
 *
 * Refresh tokens use **sessionStorage** (cleared when the tab/window closes) instead
 * of localStorage, shrinking the window for token theft across tabs/sessions.
 *
 * Migration: on first read, promote any legacy localStorage refresh token into
 * sessionStorage and remove it from localStorage.
 */

const ACCESS_LS = 'pulse_access_token';
const REFRESH_LS = 'pulse_refresh_token';
const REFRESH_SS = 'pulse_refresh_token';

export function readRefreshToken(): string | null {
  try {
    const ss = sessionStorage.getItem(REFRESH_SS);
    if (ss) return ss;
    // One-time migrate from older builds
    const ls = localStorage.getItem(REFRESH_LS);
    if (ls) {
      sessionStorage.setItem(REFRESH_SS, ls);
      localStorage.removeItem(REFRESH_LS);
      localStorage.removeItem(ACCESS_LS);
      return ls;
    }
  } catch {
    /* private mode */
  }
  return null;
}

export function writeRefreshToken(token: string | null): void {
  try {
    if (token) {
      sessionStorage.setItem(REFRESH_SS, token);
    } else {
      sessionStorage.removeItem(REFRESH_SS);
    }
    // Never leave refresh/access in localStorage
    localStorage.removeItem(REFRESH_LS);
    localStorage.removeItem(ACCESS_LS);
  } catch {
    /* */
  }
}

export function clearAllAuthTokens(): void {
  try {
    sessionStorage.removeItem(REFRESH_SS);
    localStorage.removeItem(REFRESH_LS);
    localStorage.removeItem(ACCESS_LS);
  } catch {
    /* */
  }
}
