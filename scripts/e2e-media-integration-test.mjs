/**
 * Client → API → recipient-client integration test for E2E media.
 *
 * Flow:
 *  1. Alice & Bob login (smoke users)
 *  2. Publish ECDH identity keys; create/ensure direct conversation + wraps
 *  3. Alice encrypts a PNG-like payload with conversation key (production crypto module)
 *  4. Alice POSTs message with ciphertext + e2eMeta (isE2E=true)
 *  5. Server must store application/octet-stream + PME2 magic (not plaintext)
 *  6. Bob fetches message + downloads attachment
 *  7. Bob decrypts with his conversation key → original bytes
 *  8. Reject plaintext upload under isE2E (server fail-closed)
 *
 * Usage: API_URL=http://127.0.0.1:5050 node scripts/e2e-media-integration-test.js
 */
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';
import { webcrypto } from 'crypto';

const crypto = globalThis.crypto || webcrypto;
const API = process.env.API_URL || 'http://127.0.0.1:5050';
const SMOKE_PASSWORD = process.env.SMOKE_PASSWORD || 'PulseCi_Test9x';
const LEGACY_PASSWORD = 'Password1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  encryptMediaWithConversationKey,
  decryptMediaWithConversationKey,
  isE2EMediaMeta,
  MEDIA_MAGIC,
} = await import(pathToFileURL(path.join(__dirname, '../shared/e2e-media-crypto.mjs')).href);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
let failed = 0;

function ok(name, detail = '') {
  console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, err) {
  failed += 1;
  console.error(`  ✗ ${name} — ${err instanceof Error ? err.message : err}`);
}

async function api(p, opts = {}) {
  const { headers: extra, body, ...rest } = opts;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(`${API}/api${p}`, {
    ...rest,
    body,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(extra || {}),
    },
  });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status} non-JSON`);
  }
  if (!res.ok || json.success === false) {
    const msg = json?.error?.message || json?.error?.code || JSON.stringify(json);
    const e = new Error(`${res.status} ${msg}`);
    e.status = res.status;
    e.body = json;
    throw e;
  }
  return json.data;
}

async function login(emailOrUsername) {
  for (const password of [SMOKE_PASSWORD, LEGACY_PASSWORD]) {
    try {
      return await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ emailOrUsername, password }),
      });
    } catch {
      /* next */
    }
  }
  throw new Error(`login failed for ${emailOrUsername}`);
}

function b64urlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Buffer.from(bytes).toString('base64url');
}
function b64urlDecode(s) {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}
function toArrayBuffer(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function generateIdentity() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const pubRaw = await crypto.subtle.exportKey('spki', pair.publicKey);
  const privRaw = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicB64: b64urlEncode(pubRaw),
    privateB64: b64urlEncode(privRaw),
  };
}

async function importPublicKey(b64) {
  return crypto.subtle.importKey(
    'spki',
    toArrayBuffer(b64urlDecode(b64)),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

async function deriveWrapKey(myPriv, theirPub, saltStr) {
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: theirPub },
    myPriv,
    256
  );
  const baseKey = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: textEncoder.encode(saltStr),
      info: textEncoder.encode('pulse-e2e-v1'),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function wrapGroupKey(groupKeyRaw, myPriv, theirPub, salt) {
  const wrapKey = await deriveWrapKey(myPriv, theirPub, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrapKey,
    toArrayBuffer(groupKeyRaw)
  );
  return `${b64urlEncode(iv)}:${b64urlEncode(ct)}`;
}

async function unwrapGroupKey(wrapped, myPriv, theirPub, salt) {
  const colon = wrapped.indexOf(':');
  const ivB64 = wrapped.slice(0, colon);
  const ctB64 = wrapped.slice(colon + 1);
  const wrapKey = await deriveWrapKey(myPriv, theirPub, salt);
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(b64urlDecode(ivB64)) },
    wrapKey,
    toArrayBuffer(b64urlDecode(ctB64))
  );
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function main() {
  console.log('\nE2E media integration (client → API → recipient)\n');

  // Health
  try {
    await fetch(`${API}/api/health`);
    ok('API reachable', API);
  } catch (e) {
    fail('API reachable', e);
    process.exit(1);
  }

  let alice, bob;
  try {
    alice = await login('alice');
    bob = await login('bob');
    ok('login alice+bob');
  } catch (e) {
    fail('login', e);
    process.exit(1);
  }

  const authA = { Authorization: `Bearer ${alice.accessToken}` };
  const authB = { Authorization: `Bearer ${bob.accessToken}` };
  const aliceId = String(alice.user.id || alice.user._id);
  const bobId = String(bob.user.id || bob.user._id);

  // Identity keys
  const idA = await generateIdentity();
  const idB = await generateIdentity();
  try {
    await api('/users/me/keys', {
      method: 'PUT',
      headers: authA,
      body: JSON.stringify({ identityPublicKey: idA.publicB64 }),
    });
    await api('/users/me/keys', {
      method: 'PUT',
      headers: authB,
      body: JSON.stringify({ identityPublicKey: idB.publicB64 }),
    });
    ok('publish identity keys');
  } catch (e) {
    fail('publish identity keys', e);
  }

  // Direct conversation
  let conv;
  try {
    const data = await api('/conversations/direct', {
      method: 'POST',
      headers: authA,
      body: JSON.stringify({ userId: bobId }),
    });
    conv = data.conversation || data;
    if (!conv?.id && conv?._id) conv = { ...conv, id: String(conv._id) };
    if (!conv?.id) throw new Error('no conversation id');
    ok('direct conversation', String(conv.id));
  } catch (e) {
    fail('direct conversation', e);
    process.exit(1);
  }

  // Conversation AES key + wraps (same salt + ECDH wrap as frontend e2e.ts)
  const groupKeyRaw = crypto.getRandomValues(new Uint8Array(32));
  const salt = `pulse-group-wrap:${conv.id}`;
  let wraps;
  try {
    const peerPubBob = await importPublicKey(idB.publicB64);
    // Alice wraps for self (ECDH self) and for Bob (ECDH alicePriv, bobPub)
    const wrapAlice = await wrapGroupKey(groupKeyRaw, idA.privateKey, idA.publicKey, salt);
    const wrapBob = await wrapGroupKey(groupKeyRaw, idA.privateKey, peerPubBob, salt);
    wraps = [
      { userId: aliceId, wrappedKey: wrapAlice },
      { userId: bobId, wrappedKey: wrapBob },
    ];
    await api(`/conversations/${conv.id}/e2e-keys`, {
      method: 'PUT',
      headers: authA,
      body: JSON.stringify({ wrappedKeys: wraps, version: 1 }),
    });
    ok('upload e2e wraps');
  } catch (e) {
    fail('setup conversation key', e);
    process.exit(1);
  }

  const convKeyAlice = await crypto.subtle.importKey(
    'raw',
    groupKeyRaw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  // Bob recovers key via unwrap
  let convKeyBob;
  try {
    const bobWrap = wraps.find((w) => w.userId === bobId);
    convKeyBob = await unwrapGroupKey(
      bobWrap.wrappedKey,
      idB.privateKey,
      idA.publicKey,
      salt
    );
    ok('bob unwrap conversation key');
  } catch (e) {
    fail('bob unwrap conversation key', e);
    process.exit(1);
  }

  // Minimal valid PNG header-ish payload (not a real image — content encrypted)
  const plainBytes = textEncoder.encode(
    '\x89PNG\r\n\x1a\n-pulse-e2e-media-integration-' + Date.now()
  );

  let enc;
  try {
    enc = await encryptMediaWithConversationKey(convKeyAlice, plainBytes.buffer, {
      originalName: 'secret.png',
      mimeType: 'image/png',
    });
    if (!isE2EMediaMeta(enc.e2eMeta)) throw new Error('bad meta');
    ok('alice encrypt media', `${enc.ciphertext.byteLength} bytes ct`);
  } catch (e) {
    fail('alice encrypt media', e);
    process.exit(1);
  }

  // Upload via message API
  let message;
  try {
    const form = new FormData();
    form.append('content', '');
    form.append('type', 'image');
    form.append('isE2E', 'true');
    form.append('e2eMetas', JSON.stringify([enc.e2eMeta]));
    form.append('mediaTypes', JSON.stringify(['image']));
    form.append(
      'files',
      new Blob([enc.ciphertext], { type: 'application/octet-stream' }),
      'encrypted-1.pme2'
    );
    const data = await api(`/messages/conversation/${conv.id}`, {
      method: 'POST',
      headers: authA,
      body: form,
    });
    message = data.message || data;
    if (!message?.id && message?._id) message.id = String(message._id);
    ok('alice send E2E media message', String(message.id));
  } catch (e) {
    fail('alice send E2E media message', e);
    process.exit(1);
  }

  // Assert attachment shape from API
  try {
    const att = message.attachments?.[0];
    if (!att) throw new Error('no attachment');
    if (att.mimeType !== 'application/octet-stream') {
      throw new Error(`server mime is ${att.mimeType}, expected octet-stream`);
    }
    if (!att.isE2E) throw new Error('isE2E not set on attachment');
    if (!isE2EMediaMeta(att.e2eMeta)) throw new Error('e2eMeta missing/invalid on attachment');
    if (att.originalName && !String(att.originalName).includes('encrypted')) {
      // Should be opaque name
      throw new Error(`originalName leaked plaintext? ${att.originalName}`);
    }
    ok('server attachment is opaque ciphertext metadata');
  } catch (e) {
    fail('server attachment metadata', e);
  }

  // Bob fetches history
  let bobMsg;
  try {
    const page = await api(`/messages/conversation/${conv.id}?limit=10`, {
      headers: authB,
    });
    const list = page.messages || page;
    bobMsg = (Array.isArray(list) ? list : []).find(
      (m) => String(m.id || m._id) === String(message.id)
    );
    if (!bobMsg) throw new Error('bob did not see message');
    ok('bob fetch message');
  } catch (e) {
    fail('bob fetch message', e);
    process.exit(1);
  }

  // Download ciphertext (signed URL)
  try {
    const url = bobMsg.attachments?.[0]?.url;
    if (!url) throw new Error('no url');
    const full = url.startsWith('http') ? url : `${API}${url}`;
    const res = await fetch(full);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = await res.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 4));
    if (
      head[0] !== MEDIA_MAGIC[0] ||
      head[1] !== MEDIA_MAGIC[1] ||
      head[2] !== MEDIA_MAGIC[2] ||
      head[3] !== MEDIA_MAGIC[3]
    ) {
      throw new Error('downloaded file is not PME2 (possible plaintext leak)');
    }
    // Must NOT start with PNG magic when stored
    const asLatin = textDecoder.decode(new Uint8Array(buf.slice(0, 20)));
    if (asLatin.includes('pulse-e2e-media-integration')) {
      throw new Error('plaintext payload visible in stored file');
    }
    ok('download is PME2 ciphertext (no plaintext leak)');

    const dec = await decryptMediaWithConversationKey(
      convKeyBob,
      buf,
      bobMsg.attachments[0].e2eMeta
    );
    if (!dec) throw new Error('bob decrypt failed');
    if (!Buffer.from(dec.plaintext).equals(Buffer.from(plainBytes))) {
      throw new Error('plaintext mismatch');
    }
    if (dec.mimeType !== 'image/png' || dec.originalName !== 'secret.png') {
      throw new Error(`meta mismatch ${dec.mimeType} ${dec.originalName}`);
    }
    ok('bob decrypt restores original bytes + sealed meta');
  } catch (e) {
    fail('bob download+decrypt', e);
  }

  // Server fail-closed: isE2E + plaintext image without meta must fail
  try {
    const form = new FormData();
    form.append('isE2E', 'true');
    form.append('type', 'image');
    // Minimal fake jpeg bytes
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    form.append('files', new Blob([jpeg], { type: 'image/jpeg' }), 'plain.jpg');
    let rejected = false;
    try {
      await api(`/messages/conversation/${conv.id}`, {
        method: 'POST',
        headers: authA,
        body: form,
      });
    } catch (e) {
      rejected = e.status === 400 || String(e.message).includes('400');
    }
    if (!rejected) throw new Error('server accepted plaintext under isE2E');
    ok('server rejects plaintext upload under isE2E (fail-closed)');
  } catch (e) {
    fail('server rejects plaintext under isE2E', e);
  }

  // Server fail-closed: isE2E + octet-stream without e2eMetas
  try {
    const form = new FormData();
    form.append('isE2E', 'true');
    form.append(
      'files',
      new Blob([new Uint8Array([0x50, 0x4d, 0x45, 0x32])], {
        type: 'application/octet-stream',
      }),
      'x.pme2'
    );
    let rejected = false;
    try {
      await api(`/messages/conversation/${conv.id}`, {
        method: 'POST',
        headers: authA,
        body: form,
      });
    } catch (e) {
      rejected = e.status === 400 || String(e.message).includes('400');
    }
    if (!rejected) throw new Error('server accepted E2E file without meta');
    ok('server rejects E2E file without e2eMetas');
  } catch (e) {
    fail('server rejects missing e2eMetas', e);
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: E2E media integration (${failed} failed)\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
