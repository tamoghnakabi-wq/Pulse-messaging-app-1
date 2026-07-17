/**
 * Pulse E2E media crypto core (shared — browser + Node tests).
 *
 * Production frontend wraps this with conversation-key resolution.
 * Tests import THIS module so they exercise the real algorithm, not a mirror.
 *
 * Wire format:
 *   PME2 | ver(1) | chunkSize u32be | chunkCount u32be
 *   per chunk: iv(12) | AES-GCM(ct+tag) AAD = chunk index u32be
 *
 * e2eMeta:
 *   e2e-media:2:<wrapIv>:<wrappedMediaKey>:<metaIv>:<encMeta>
 *   encMeta = AES-GCM(mediaKey, JSON { n, m, s, h, cs, c })
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const MEDIA_E2E_PREFIX_V1 = 'e2e-media:1:';
export const MEDIA_E2E_PREFIX_V2 = 'e2e-media:2:';
export const MEDIA_MAGIC = new Uint8Array([0x50, 0x4d, 0x45, 0x32]); // "PME2"
export const MEDIA_FORMAT_VERSION = 2;
/** 256 KiB chunks */
export const MEDIA_CHUNK_SIZE = 256 * 1024;

function toArrayBuffer(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function b64urlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, Array.from(sub));
  }
  // Node + browser
  if (typeof btoa === 'function') {
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return Buffer.from(binary, 'binary').toString('base64url');
}

function b64urlDecode(s) {
  if (typeof atob === 'function') {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

function u32be(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

function readU32be(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

async function sha256Hex(data) {
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

async function importAesRaw(raw, extractable = false) {
  return crypto.subtle.importKey(
    'raw',
    raw instanceof Uint8Array ? toArrayBuffer(raw) : raw,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt']
  );
}

/** Structural validation of e2eMeta (no crypto) — server + client. */
export function isE2EMediaMeta(meta) {
  if (!meta || typeof meta !== 'string') return false;
  if (meta.startsWith(MEDIA_E2E_PREFIX_V1)) {
    const rest = meta.slice(MEDIA_E2E_PREFIX_V1.length);
    return rest.length >= 8 && rest.length <= 128 && !rest.includes(':');
  }
  if (meta.startsWith(MEDIA_E2E_PREFIX_V2)) {
    const rest = meta.slice(MEDIA_E2E_PREFIX_V2.length);
    const parts = rest.split(':');
    if (parts.length !== 4) return false;
    return parts.every((p) => typeof p === 'string' && p.length >= 8 && p.length <= 3000);
  }
  return false;
}

/**
 * Encrypt plaintext with a fresh media key; wrap media key with conversation AES key.
 * @param {CryptoKey} conversationKey AES-GCM key
 * @param {ArrayBuffer} plaintextBuf
 * @param {{ originalName?: string, mimeType?: string }} [opts]
 */
export async function encryptMediaWithConversationKey(conversationKey, plaintextBuf, opts = {}) {
  const originalName = String(opts.originalName || 'file').slice(0, 255);
  const mimeType = String(opts.mimeType || 'application/octet-stream').slice(0, 128);

  const mediaKeyRaw = crypto.getRandomValues(new Uint8Array(32));
  const mediaKey = await importAesRaw(mediaKeyRaw, false);

  const contentHash = await sha256Hex(plaintextBuf);
  const plaintextSize = plaintextBuf.byteLength;
  const chunkSize = MEDIA_CHUNK_SIZE;
  const chunkCount = Math.max(1, Math.ceil(plaintextSize / chunkSize) || 1);

  const header = new Uint8Array(13);
  header.set(MEDIA_MAGIC, 0);
  header[4] = MEDIA_FORMAT_VERSION;
  header.set(u32be(chunkSize), 5);
  header.set(u32be(chunkCount), 9);

  /** @type {BlobPart[]} */
  const parts = [header];
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, plaintextSize);
    const chunk = plaintextBuf.slice(start, end);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = toArrayBuffer(u32be(i));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      mediaKey,
      chunk
    );
    parts.push(iv, ct);
  }

  // Ciphertext SHA-256 binds meta to this blob (detects meta/ciphertext swap)
  let totalLen = 0;
  for (const p of parts) {
    totalLen += p instanceof ArrayBuffer ? p.byteLength : p.byteLength ?? p.length;
  }
  const cipherBytes = new Uint8Array(totalLen);
  let o = 0;
  for (const p of parts) {
    const u = p instanceof Uint8Array ? p : new Uint8Array(p);
    cipherBytes.set(u, o);
    o += u.byteLength;
  }
  const ciphertextHash = await sha256Hex(cipherBytes.buffer);

  const metaPayload = JSON.stringify({
    n: originalName,
    m: mimeType,
    s: plaintextSize,
    h: contentHash,
    ch: ciphertextHash,
    cs: chunkSize,
    c: chunkCount,
    v: MEDIA_FORMAT_VERSION,
  });
  const metaIv = crypto.getRandomValues(new Uint8Array(12));
  const encMeta = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: metaIv },
    mediaKey,
    textEncoder.encode(metaPayload)
  );

  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: wrapIv },
    conversationKey,
    toArrayBuffer(mediaKeyRaw)
  );

  const e2eMeta = `${MEDIA_E2E_PREFIX_V2}${b64urlEncode(wrapIv)}:${b64urlEncode(wrapped)}:${b64urlEncode(metaIv)}:${b64urlEncode(encMeta)}`;
  mediaKeyRaw.fill(0);

  if (!isE2EMediaMeta(e2eMeta)) {
    throw new Error('Produced invalid e2eMeta');
  }

  return {
    ciphertext: cipherBytes.buffer,
    e2eMeta,
    originalName,
    mimeType,
    plaintextSize,
    contentHash,
    ciphertextHash,
  };
}

/**
 * Decrypt ciphertext + e2eMeta with conversation AES key.
 * Verifies plaintext hash and optional ciphertext hash.
 * @returns {Promise<{ plaintext: ArrayBuffer, originalName: string, mimeType: string, size: number, contentHash: string } | null>}
 */
export async function decryptMediaWithConversationKey(conversationKey, ciphertext, e2eMeta) {
  try {
    if (!isE2EMediaMeta(e2eMeta)) return null;

    // v1: whole-file AES-GCM under conversation key
    if (e2eMeta.startsWith(MEDIA_E2E_PREFIX_V1)) {
      const ivB64 = e2eMeta.slice(MEDIA_E2E_PREFIX_V1.length);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(b64urlDecode(ivB64)) },
        conversationKey,
        ciphertext
      );
      return {
        plaintext: plain,
        originalName: 'file',
        mimeType: 'application/octet-stream',
        size: plain.byteLength,
        contentHash: await sha256Hex(plain),
      };
    }

    const rest = e2eMeta.slice(MEDIA_E2E_PREFIX_V2.length);
    const parts = rest.split(':');
    if (parts.length !== 4) return null;
    const [wrapIv, wrapped, metaIvB64, encMetaB64] = parts;

    const mediaKeyRaw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(b64urlDecode(wrapIv)) },
      conversationKey,
      toArrayBuffer(b64urlDecode(wrapped))
    );
    const mediaKey = await importAesRaw(mediaKeyRaw, false);

    const metaJson = textDecoder.decode(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(b64urlDecode(metaIvB64)) },
        mediaKey,
        toArrayBuffer(b64urlDecode(encMetaB64))
      )
    );
    const meta = JSON.parse(metaJson);
    const originalName = typeof meta.n === 'string' ? meta.n.slice(0, 255) : 'file';
    const mimeType =
      typeof meta.m === 'string' ? meta.m.slice(0, 128) : 'application/octet-stream';
    const expectedHash = typeof meta.h === 'string' ? meta.h : '';
    const expectedCipherHash = typeof meta.ch === 'string' ? meta.ch : '';
    const hdrChunkSize =
      typeof meta.cs === 'number' && meta.cs > 0 ? meta.cs : MEDIA_CHUNK_SIZE;

    // Authenticity: ciphertext must match sealed hash when present
    if (expectedCipherHash) {
      const actualCh = await sha256Hex(ciphertext);
      if (actualCh !== expectedCipherHash) return null;
    }

    const bytes = new Uint8Array(ciphertext);
    let offset = 0;
    let useChunked = false;
    let chunkCount = typeof meta.c === 'number' && meta.c > 0 ? meta.c : 0;
    let chunkSize = hdrChunkSize;

    if (
      bytes.length >= 13 &&
      bytes[0] === MEDIA_MAGIC[0] &&
      bytes[1] === MEDIA_MAGIC[1] &&
      bytes[2] === MEDIA_MAGIC[2] &&
      bytes[3] === MEDIA_MAGIC[3]
    ) {
      const ver = bytes[4];
      if (ver !== MEDIA_FORMAT_VERSION && ver !== 1) return null;
      chunkSize = readU32be(bytes, 5);
      chunkCount = readU32be(bytes, 9);
      // Header must agree with sealed meta when both present
      if (typeof meta.cs === 'number' && meta.cs > 0 && meta.cs !== chunkSize) return null;
      if (typeof meta.c === 'number' && meta.c > 0 && meta.c !== chunkCount) return null;
      offset = 13;
      useChunked = true;
    }

    let plaintext;
    if (useChunked) {
      const plainParts = [];
      let total = 0;
      for (let i = 0; i < chunkCount; i++) {
        if (offset + 12 > bytes.length) return null;
        const iv = bytes.subarray(offset, offset + 12);
        offset += 12;
        const isLast = i === chunkCount - 1;
        const ctLen = isLast ? bytes.length - offset : chunkSize + 16;
        if (ctLen < 16 || offset + ctLen > bytes.length) return null;
        const ct = bytes.subarray(offset, offset + ctLen);
        offset += ctLen;
        const pt = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: toArrayBuffer(iv),
              additionalData: toArrayBuffer(u32be(i)),
            },
            mediaKey,
            toArrayBuffer(ct)
          )
        );
        plainParts.push(pt);
        total += pt.byteLength;
      }
      if (offset !== bytes.length) return null; // trailing garbage
      const out = new Uint8Array(total);
      let po = 0;
      for (const p of plainParts) {
        out.set(p, po);
        po += p.byteLength;
      }
      plaintext = out.buffer;
    } else {
      plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(b64urlDecode(metaIvB64)) },
        mediaKey,
        ciphertext
      );
    }

    // Sealed size must match
    if (typeof meta.s === 'number' && meta.s >= 0 && meta.s !== plaintext.byteLength) {
      return null;
    }

    const actualHash = await sha256Hex(plaintext);
    if (expectedHash && expectedHash !== actualHash) return null;

    return {
      plaintext,
      originalName,
      mimeType,
      size: plaintext.byteLength,
      contentHash: actualHash,
    };
  } catch {
    return null;
  }
}
