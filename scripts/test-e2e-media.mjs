/**
 * Unit tests for production E2E media crypto.
 * Imports shared/e2e-media-crypto.mjs (same module the frontend uses) — not a mirror.
 *
 * Run: node scripts/test-e2e-media.js
 *      npm run test:e2e-media
 */
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corePath = path.join(__dirname, '../shared/e2e-media-crypto.mjs');

const {
  encryptMediaWithConversationKey,
  decryptMediaWithConversationKey,
  isE2EMediaMeta,
  MEDIA_E2E_PREFIX_V2,
  MEDIA_CHUNK_SIZE,
  MEDIA_MAGIC,
} = await import(pathToFileURL(corePath).href);

const crypto = globalThis.crypto;
if (!crypto?.subtle) {
  console.error('Web Crypto required (Node 20+)');
  process.exit(1);
}

const textEncoder = new TextEncoder();

async function importAes(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const convKey = await importAes(crypto.getRandomValues(new Uint8Array(32)));

  // 1) Small payload
  const small = textEncoder.encode('PNG-fake-payload-hello-pulse-e2e');
  const r1 = await encryptMediaWithConversationKey(convKey, small.buffer, {
    originalName: 'photo.png',
    mimeType: 'image/png',
  });
  assert(isE2EMediaMeta(r1.e2eMeta), 'valid e2eMeta');
  assert(r1.e2eMeta.startsWith(MEDIA_E2E_PREFIX_V2), 'v2 prefix');
  const c1 = new Uint8Array(r1.ciphertext);
  assert(
    c1[0] === MEDIA_MAGIC[0] && c1[3] === MEDIA_MAGIC[3],
    'PME2 magic'
  );
  const d1 = await decryptMediaWithConversationKey(convKey, r1.ciphertext, r1.e2eMeta);
  assert(d1, 'decrypt ok');
  assert(Buffer.from(d1.plaintext).equals(Buffer.from(small)), 'small roundtrip');
  assert(d1.originalName === 'photo.png' && d1.mimeType === 'image/png', 'meta names');
  assert(d1.contentHash === r1.contentHash, 'hash match');
  console.log('✓ small file roundtrip + integrity (production module)');

  // 2) Multi-chunk
  const big = new Uint8Array(MEDIA_CHUNK_SIZE * 2 + 100);
  for (let i = 0; i < big.length; i += 65536) {
    crypto.getRandomValues(big.subarray(i, Math.min(i + 65536, big.length)));
  }
  const r2 = await encryptMediaWithConversationKey(convKey, big.buffer, {
    originalName: 'clip.mp4',
    mimeType: 'video/mp4',
  });
  const d2 = await decryptMediaWithConversationKey(convKey, r2.ciphertext, r2.e2eMeta);
  assert(d2 && d2.plaintext.byteLength === big.byteLength, 'big size');
  assert(Buffer.from(d2.plaintext).equals(Buffer.from(big)), 'big roundtrip');
  console.log('✓ multi-chunk (large) roundtrip');

  // 3) Empty
  const r3 = await encryptMediaWithConversationKey(convKey, new ArrayBuffer(0), {
    originalName: 'empty.txt',
    mimeType: 'text/plain',
  });
  const d3 = await decryptMediaWithConversationKey(convKey, r3.ciphertext, r3.e2eMeta);
  assert(d3 && d3.plaintext.byteLength === 0, 'empty');
  console.log('✓ empty file');

  // 4) Tamper ciphertext
  const r4 = await encryptMediaWithConversationKey(convKey, small.buffer, {
    originalName: 't.png',
    mimeType: 'image/png',
  });
  const tampered = new Uint8Array(r4.ciphertext);
  tampered[tampered.length - 5] ^= 0xff;
  const d4 = await decryptMediaWithConversationKey(convKey, tampered.buffer, r4.e2eMeta);
  assert(d4 === null, 'tamper should fail');
  console.log('✓ tamper detection (GCM + ciphertext hash)');

  // 5) Wrong conversation key
  const wrongKey = await importAes(crypto.getRandomValues(new Uint8Array(32)));
  const d5 = await decryptMediaWithConversationKey(wrongKey, r1.ciphertext, r1.e2eMeta);
  assert(d5 === null, 'wrong key rejected');
  console.log('✓ wrong conversation key rejected');

  // 6) Meta/ciphertext swap authenticity
  const r6a = await encryptMediaWithConversationKey(convKey, textEncoder.encode('AAA').buffer, {
    originalName: 'a.txt',
    mimeType: 'text/plain',
  });
  const r6b = await encryptMediaWithConversationKey(convKey, textEncoder.encode('BBB').buffer, {
    originalName: 'b.txt',
    mimeType: 'text/plain',
  });
  // Swap meta → ciphertext hash mismatch
  const d6 = await decryptMediaWithConversationKey(convKey, r6a.ciphertext, r6b.e2eMeta);
  assert(d6 === null, 'swapped meta rejected');
  console.log('✓ meta/ciphertext swap rejected (ciphertext hash)');

  // 7) No plaintext leak in header
  const sample = c1.subarray(0, 64);
  const asText = Buffer.from(sample).toString('utf8');
  assert(!asText.includes('image/png'), 'no mime leak');
  assert(!asText.includes('photo.png'), 'no name leak');
  console.log('✓ no plaintext name/mime in ciphertext header');

  // 8) isE2EMediaMeta rejects garbage
  assert(!isE2EMediaMeta(''), 'empty');
  assert(!isE2EMediaMeta('e2e-media:2:a:b'), 'short v2');
  assert(!isE2EMediaMeta('plaintext'), 'plaintext');
  console.log('✓ isE2EMediaMeta validation');

  console.log('\nAll E2E media crypto tests passed (production shared module).');
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
