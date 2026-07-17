/**
 * Strip EXIF / APP1 metadata from JPEG images without external deps.
 * PNG/WebP/GIF: leave as-is (no EXIF in common cases for our pipeline).
 * Safe no-op if file is not JPEG or rewrite fails.
 */
import fs from 'fs';
import logger from './logger';

/** Remove JPEG APP1 (EXIF) and APP2 segments; keep image data. */
export function stripJpegExif(filePath: string): boolean {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
      return false; // not JPEG
    }

    const out: number[] = [0xff, 0xd8];
    let i = 2;
    let stripped = false;

    while (i < buf.length - 1) {
      if (buf[i] !== 0xff) {
        // Entropy-coded data — copy rest
        for (let j = i; j < buf.length; j++) out.push(buf[j]);
        break;
      }
      const marker = buf[i + 1];
      // Standalone markers without length
      if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        out.push(0xff, marker);
        i += 2;
        continue;
      }
      // SOS — copy rest of file
      if (marker === 0xda) {
        for (let j = i; j < buf.length; j++) out.push(buf[j]);
        break;
      }
      if (i + 3 >= buf.length) break;
      const len = (buf[i + 2] << 8) | buf[i + 3];
      if (len < 2 || i + 2 + len > buf.length) break;

      // APP1 (EXIF/XMP) and APP2 (ICC) — drop
      if (marker === 0xe1 || marker === 0xe2) {
        stripped = true;
        i += 2 + len;
        continue;
      }

      for (let j = i; j < i + 2 + len; j++) out.push(buf[j]);
      i += 2 + len;
    }

    if (stripped && out.length > 4) {
      fs.writeFileSync(filePath, Buffer.from(out));
      return true;
    }
    return false;
  } catch (err) {
    logger.warn('[image-sanitize] strip failed', {
      message: err instanceof Error ? err.message : 'unknown',
    });
    return false;
  }
}

/** Best-effort metadata strip for uploaded images. */
export function stripImageMetadata(filePath: string, mime: string): void {
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    stripJpegExif(filePath);
  }
  // PNG/WebP: EXIF rare; full strip would need re-encode (sharp) — skipped without deps
}
