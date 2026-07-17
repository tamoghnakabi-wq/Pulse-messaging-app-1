import path from 'path';

/** Strip path separators and control chars from uploaded original filenames. */
export function sanitizeFilename(name: string, maxLen = 180): string {
  // Intentionally strip ASCII control characters from untrusted filenames
  // eslint-disable-next-line no-control-regex -- control-char scrubbing is the point
  const base = path.basename(String(name || 'file')).replace(/[\u0000-\u001f\u007f]/g, '');
  const cleaned = base.replace(/[<>:"|?*\\/]/g, '_').trim() || 'file';
  return cleaned.slice(0, maxLen);
}

/** Escape user input for safe RegExp construction. */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Validate MongoDB ObjectId-looking strings without throwing. */
export function isObjectIdString(id: unknown): id is string {
  return typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id);
}
