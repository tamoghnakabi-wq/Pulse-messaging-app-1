/**
 * Structural validation of client E2E media envelopes.
 * Server never decrypts — only checks format so we refuse garbage / mixed plaintext.
 */

const PREFIX_V1 = 'e2e-media:1:';
const PREFIX_V2 = 'e2e-media:2:';

/** True when string looks like a valid opaque e2e media meta envelope. */
export function isValidE2EMediaMeta(meta: unknown): boolean {
  if (typeof meta !== 'string' || meta.length < 16 || meta.length > 4096) return false;
  if (meta.startsWith(PREFIX_V1)) {
    const rest = meta.slice(PREFIX_V1.length);
    return rest.length >= 8 && rest.length <= 128 && !rest.includes(':');
  }
  if (meta.startsWith(PREFIX_V2)) {
    const rest = meta.slice(PREFIX_V2.length);
    const parts = rest.split(':');
    if (parts.length !== 4) return false;
    return parts.every((p) => typeof p === 'string' && p.length >= 8 && p.length <= 3000);
  }
  return false;
}
