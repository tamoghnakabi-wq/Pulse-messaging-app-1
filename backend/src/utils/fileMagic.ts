import fs from 'fs';

/** Minimal magic-byte checks — reject obvious MIME spoofing for common types. */
export function fileMatchesMime(filePath: string, mime: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    if (n < 4) return false;

    if (mime === 'image/jpeg') {
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    }
    if (mime === 'image/png') {
      return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    }
    if (mime === 'image/gif') {
      return buf.slice(0, 4).toString('ascii') === 'GIF8';
    }
    if (mime === 'image/webp') {
      return (
        buf.slice(0, 4).toString('ascii') === 'RIFF' &&
        buf.slice(8, 12).toString('ascii') === 'WEBP'
      );
    }
    if (mime === 'application/pdf') {
      return buf.slice(0, 4).toString('ascii') === '%PDF';
    }
    if (mime === 'video/webm' || mime === 'audio/webm') {
      // EBML header
      return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
    }
    if (mime === 'video/mp4' || mime === 'audio/mp4' || mime === 'audio/x-m4a') {
      // ftyp box often at offset 4
      return buf.slice(4, 8).toString('ascii') === 'ftyp';
    }
    if (mime === 'audio/mpeg' || mime === 'audio/mp3') {
      // ID3 or frame sync
      return (
        (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) ||
        (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
      );
    }
    if (mime === 'application/zip' || mime.includes('officedocument')) {
      return buf[0] === 0x50 && buf[1] === 0x4b;
    }
    if (mime === 'text/plain' || mime === 'text/csv') {
      // Reject if high ratio of nulls (binary)
      let nulls = 0;
      for (let i = 0; i < n; i++) if (buf[i] === 0) nulls++;
      return nulls === 0;
    }
    // Client E2E media: PME2 magic ("PME2") or opaque binary (still allowed)
    if (mime === 'application/octet-stream') {
      if (n >= 4 && buf[0] === 0x50 && buf[1] === 0x4d && buf[2] === 0x45 && buf[3] === 0x32) {
        return true; // Pulse Media E2E v2
      }
      // Accept other opaque ciphertext (v1 had no header)
      return true;
    }
    // Unknown allowlisted types — accept (filtered by mime allowlist already)
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* */
      }
    }
  }
}

export function unlinkQuiet(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* */
  }
}
