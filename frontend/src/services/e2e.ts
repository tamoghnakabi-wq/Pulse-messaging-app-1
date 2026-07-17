/**
 * Pulse end-to-end encryption (client-side).
 *
 * Design (v1):
 * - Each user has an ECDH P-256 identity key pair (private never leaves this device).
 * - Direct chats: ECDH(myPriv, peerPub) → HKDF → AES-GCM conversation key.
 * - Group chats: random AES-GCM group key, wrapped for each member via ECDH.
 * - Server only stores ciphertext + public keys + wrapped group keys.
 *
 * Message envelope:  🔐e2e:1:<iv_b64url>:<ct_b64url>
 */
import api from '@/shared/api/client';
import { extractData } from '@/shared/api/extract';
import type { Conversation, Message, User } from '@/shared/types';

const PRIV_KEY_LEGACY = 'pulse_e2e_priv_pkcs8';
const PUB_KEY_LEGACY = 'pulse_e2e_pub_spki';
/** Per-user device key storage — avoids tk1/tk2 sharing one keypair on the same browser */
const privKeyStorage = (userId: string) => `pulse_e2e_priv_pkcs8:${userId}`;
const pubKeyStorage = (userId: string) => `pulse_e2e_pub_spki:${userId}`;
/** Durable conversation AES keys so refresh can decrypt even if wraps lag or fail */
const convKeyStorage = (userId: string, convId: string) =>
  `pulse_e2e_conv_aes:${userId}:${convId}`;
export const E2E_PREFIX = '🔐e2e:1:';
const LOCKED = '🔒 Encrypted message';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// In-memory caches (per session)
let privateKey: CryptoKey | null = null;
let publicKey: CryptoKey | null = null;
let publicKeyB64 = '';
/** Which user the in-memory identity belongs to */
let identityUserId = '';
const peerPubCache = new Map<string, { key: CryptoKey; b64: string; at: number }>();
const directKeyCache = new Map<string, CryptoKey>();
const groupKeyCache = new Map<string, CryptoKey>();
const PEER_PUB_TTL_MS = 60_000;
/** Throttle PUT /e2e-keys redistributes — was flooding API and tripping rate limits */
const lastWrapPushAt = new Map<string, number>();
const WRAP_PUSH_TTL_MS = 90_000;
let lastPublishedPub = '';

/** True when content is still ciphertext or the lock placeholder (not human-readable). */
export function isLockedOrCiphertext(content?: string | null): boolean {
  if (!content) return false;
  return content.startsWith(E2E_PREFIX) || content.startsWith('🔒');
}

/** Prefer already-decrypted / plaintext over ciphertext or lock placeholder. */
export function preferReadableContent(prev?: string, next?: string): string {
  const p = prev || '';
  const n = next || '';
  if (p && !isLockedOrCiphertext(p) && isLockedOrCiphertext(n)) return p;
  if (n && !isLockedOrCiphertext(n)) return n;
  if (n) return n;
  return p;
}

function participantUserId(p: { user?: User | string | null } | undefined): string {
  if (!p?.user) return '';
  if (typeof p.user === 'string') return p.user;
  return p.user.id || '';
}

/** Copy bytes into a clean ArrayBuffer (avoids SharedArrayBuffer / offset bugs). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, Array.from(sub));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(buf: ArrayBuffer): string {
  return b64urlEncode(buf);
}

function b64ToBytes(s: string): Uint8Array {
  return b64urlDecode(s.replace(/\+/g, '-').replace(/\//g, '_'));
}

export function isE2ECiphertext(content?: string | null): boolean {
  return typeof content === 'string' && content.startsWith(E2E_PREFIX);
}

export function e2eSupported(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

function sameId(a?: string | null, b?: string | null): boolean {
  return String(a || '') === String(b || '');
}

async function generateIdentity(): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicB64: string;
  privateB64: string;
}> {
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
    publicB64: bytesToB64(pubRaw),
    privateB64: bytesToB64(privRaw),
  };
}

async function importPublicKey(b64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(b64);
  return crypto.subtle.importKey(
    'spki',
    toArrayBuffer(raw),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

async function importPrivateKey(b64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(b64);
  return crypto.subtle.importKey(
    'pkcs8',
    toArrayBuffer(raw),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
}

async function deriveAesKey(
  myPriv: CryptoKey,
  theirPub: CryptoKey,
  saltStr: string
): Promise<CryptoKey> {
  // P-256 shared secret = 32 bytes
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

async function aesEncrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(plaintext)
  );
  return `${E2E_PREFIX}${b64urlEncode(iv)}:${b64urlEncode(ct)}`;
}

async function aesDecrypt(key: CryptoKey, envelope: string): Promise<string> {
  if (!envelope.startsWith(E2E_PREFIX)) return envelope;
  const rest = envelope.slice(E2E_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon < 1) throw new Error('Malformed E2E envelope');
  const ivB64 = rest.slice(0, colon);
  const ctB64 = rest.slice(colon + 1);
  if (!ctB64) throw new Error('Malformed E2E envelope');
  const iv = b64urlDecode(ivB64);
  const ct = b64urlDecode(ctB64);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ct)
  );
  return textDecoder.decode(pt);
}

async function wrapGroupKey(
  groupKeyRaw: Uint8Array,
  myPriv: CryptoKey,
  theirPub: CryptoKey,
  salt: string
): Promise<string> {
  const wrapKey = await deriveAesKey(myPriv, theirPub, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrapKey,
    toArrayBuffer(groupKeyRaw)
  );
  return `${b64urlEncode(iv)}:${b64urlEncode(ct)}`;
}

async function unwrapGroupKey(
  wrapped: string,
  myPriv: CryptoKey,
  theirPub: CryptoKey,
  salt: string
): Promise<CryptoKey> {
  const colon = wrapped.indexOf(':');
  if (colon < 1) throw new Error('Malformed wrapped key');
  const ivB64 = wrapped.slice(0, colon);
  const ctB64 = wrapped.slice(colon + 1);
  const wrapKey = await deriveAesKey(myPriv, theirPub, salt);
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(b64urlDecode(ivB64)) },
    wrapKey,
    toArrayBuffer(b64urlDecode(ctB64))
  );
  // extractable: true so we can re-wrap (self-wrap / peer redistribute) without rekey
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

function resolveUserId(explicit?: string): string {
  if (explicit) return explicit;
  if (identityUserId) return identityUserId;
  try {
    // Dynamic import is async — use a soft global set by auth bootstrap when present
    const g = globalThis as { __pulseUserId?: string };
    if (g.__pulseUserId) return g.__pulseUserId;
  } catch {
    /* */
  }
  return '';
}

/** Call on login so E2E helpers know the active user without circular imports. */
export function setE2EUserContext(userId: string | null | undefined): void {
  try {
    const g = globalThis as { __pulseUserId?: string };
    if (userId) g.__pulseUserId = userId;
    else delete g.__pulseUserId;
  } catch {
    /* */
  }
  if (userId && identityUserId && identityUserId !== userId) {
    clearE2ESessionCaches();
  }
  if (userId) identityUserId = userId;
}

interface E2EKeyBackupBlob {
  v: number;
  publicKey: string;
  salt: string;
  iv: string;
  ciphertext: string;
}

async function deriveBackupKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations: 120_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function createE2EKeyBackup(password: string, privateB64: string, publicB64: string): Promise<E2EKeyBackupBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(password, salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(privateB64)
  );
  return {
    v: 1,
    publicKey: publicB64,
    salt: b64urlEncode(salt),
    iv: b64urlEncode(iv),
    ciphertext: b64urlEncode(ct),
  };
}

async function restoreFromE2EKeyBackup(
  password: string,
  backup: E2EKeyBackupBlob
): Promise<{ privateB64: string; publicB64: string } | null> {
  try {
    const salt = b64urlDecode(backup.salt);
    const iv = b64urlDecode(backup.iv);
    const key = await deriveBackupKey(password, salt);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(b64urlDecode(backup.ciphertext))
    );
    const privateB64 = textDecoder.decode(pt);
    if (!privateB64 || !backup.publicKey) return null;
    // Validate importable
    await importPrivateKey(privateB64);
    await importPublicKey(backup.publicKey);
    return { privateB64, publicB64: backup.publicKey };
  } catch {
    return null;
  }
}

async function fetchServerE2EBackup(): Promise<E2EKeyBackupBlob | null> {
  try {
    const res = await api.get('/users/me/e2e-backup');
    const data = extractData<{ backup: E2EKeyBackupBlob | null }>(res);
    return data.backup || null;
  } catch {
    return null;
  }
}

async function uploadE2EKeyBackup(backup: E2EKeyBackupBlob): Promise<void> {
  try {
    await api.put('/users/me/e2e-backup', backup);
  } catch {
    /* non-fatal */
  }
}

function persistLocalKeys(userId: string, publicB64: string, privateB64: string): void {
  try {
    localStorage.setItem(pubKeyStorage(userId), publicB64);
    localStorage.setItem(privKeyStorage(userId), privateB64);
  } catch {
    /* private mode */
  }
}

/**
 * Ensure local identity keys exist for this user and are published to the server.
 * Pass `password` on login/register so keys can be restored from server backup
 * after origin changes (Cloudflare tunnel URL rotation) and re-backed up.
 */
export async function ensureIdentityKeys(
  forUserId?: string,
  opts?: { password?: string }
): Promise<string> {
  if (!e2eSupported()) return '';

  const userId = resolveUserId(forUserId);
  if (!userId) {
    // No user context yet — do not invent a global keypair
    return publicKeyB64 || '';
  }

  // Switching accounts on the same browser must swap key material
  if (identityUserId && identityUserId !== userId) {
    privateKey = null;
    publicKey = null;
    publicKeyB64 = '';
    peerPubCache.clear();
    directKeyCache.clear();
    groupKeyCache.clear();
  }
  identityUserId = userId;

  if (privateKey && publicKeyB64) {
    // Refresh password-wrapped server backup when password is available
    if (opts?.password) {
      const privB64 = localStorage.getItem(privKeyStorage(userId)) || '';
      if (privB64) {
        void createE2EKeyBackup(opts.password, privB64, publicKeyB64).then(uploadE2EKeyBackup);
      }
    }
    // Only publish public key when it changes (avoid rate-limit spam)
    if (lastPublishedPub !== publicKeyB64) {
      try {
        await api.put('/users/me/keys', { identityPublicKey: publicKeyB64 });
        lastPublishedPub = publicKeyB64;
      } catch {
        /* */
      }
    }
    return publicKeyB64;
  }

  let storedPub = localStorage.getItem(pubKeyStorage(userId)) || '';
  let storedPriv = localStorage.getItem(privKeyStorage(userId)) || '';

  // One-time migrate legacy global keys → per-user (only if no per-user keys yet)
  if (!storedPub || !storedPriv) {
    const legPub = localStorage.getItem(PUB_KEY_LEGACY) || '';
    const legPriv = localStorage.getItem(PRIV_KEY_LEGACY) || '';
    if (legPub && legPriv) {
      storedPub = legPub;
      storedPriv = legPriv;
      try {
        localStorage.setItem(pubKeyStorage(userId), legPub);
        localStorage.setItem(privKeyStorage(userId), legPriv);
        localStorage.removeItem(PUB_KEY_LEGACY);
        localStorage.removeItem(PRIV_KEY_LEGACY);
      } catch {
        /* */
      }
    }
  }

  if (storedPub && storedPriv) {
    try {
      privateKey = await importPrivateKey(storedPriv);
      publicKey = await importPublicKey(storedPub);
      publicKeyB64 = storedPub;
    } catch {
      privateKey = null;
      publicKey = null;
      publicKeyB64 = '';
      try {
        localStorage.removeItem(privKeyStorage(userId));
        localStorage.removeItem(pubKeyStorage(userId));
      } catch {
        /* */
      }
    }
  }

  // No local keys (new browser / tunnel URL) — restore from password-wrapped server backup
  if ((!privateKey || !publicKeyB64) && opts?.password) {
    const backup = await fetchServerE2EBackup();
    if (backup) {
      const restored = await restoreFromE2EKeyBackup(opts.password, backup);
      if (restored) {
        try {
          privateKey = await importPrivateKey(restored.privateB64);
          publicKey = await importPublicKey(restored.publicB64);
          publicKeyB64 = restored.publicB64;
          persistLocalKeys(userId, restored.publicB64, restored.privateB64);
          peerPubCache.clear();
          directKeyCache.clear();
          groupKeyCache.clear();
        } catch {
          privateKey = null;
          publicKey = null;
          publicKeyB64 = '';
        }
      }
    }
  }

  // Still no keys — generate new identity (history encrypted with old keys is unrecoverable)
  if (!privateKey || !publicKeyB64) {
    const gen = await generateIdentity();
    privateKey = gen.privateKey;
    publicKey = gen.publicKey;
    publicKeyB64 = gen.publicB64;
    persistLocalKeys(userId, gen.publicB64, gen.privateB64);
    peerPubCache.clear();
    directKeyCache.clear();
    groupKeyCache.clear();
  }

  // Always refresh password-wrapped backup when password is available (both accounts!)
  if (opts?.password && publicKeyB64) {
    const privB64 = localStorage.getItem(privKeyStorage(userId)) || '';
    if (privB64) {
      try {
        const backup = await createE2EKeyBackup(opts.password, privB64, publicKeyB64);
        await uploadE2EKeyBackup(backup);
      } catch {
        /* non-fatal but backup is important */
      }
    }
  }

  if (publicKeyB64 && lastPublishedPub !== publicKeyB64) {
    try {
      await api.put('/users/me/keys', { identityPublicKey: publicKeyB64 });
      lastPublishedPub = publicKeyB64;
    } catch {
      /* retry later */
    }
  }

  return publicKeyB64;
}

export function getLocalPublicKeyB64(userId?: string): string {
  if (publicKeyB64) return publicKeyB64;
  const uid = resolveUserId(userId);
  if (uid) return localStorage.getItem(pubKeyStorage(uid)) || '';
  return localStorage.getItem(PUB_KEY_LEGACY) || '';
}

async function fetchPeerPublicKey(
  userId: string,
  opts?: { force?: boolean }
): Promise<CryptoKey | null> {
  const cached = peerPubCache.get(userId);
  if (
    !opts?.force &&
    cached &&
    Date.now() - cached.at < PEER_PUB_TTL_MS
  ) {
    return cached.key;
  }
  try {
    const res = await api.get(`/users/${userId}/keys`);
    const data = extractData<{ userId: string; identityPublicKey: string }>(res);
    if (!data.identityPublicKey) return null;
    // If public key rotated, drop direct AES cache for this peer
    if (cached && cached.b64 !== data.identityPublicKey) {
      for (const k of [...directKeyCache.keys()]) {
        if (k.includes(userId)) directKeyCache.delete(k);
      }
    }
    const key = await importPublicKey(data.identityPublicKey);
    peerPubCache.set(userId, { key, b64: data.identityPublicKey, at: Date.now() });
    return key;
  } catch {
    return null;
  }
}

function directSalt(myId: string, peerId: string): string {
  const [a, b] = [myId, peerId].sort();
  return `pulse-direct:${a}:${b}`;
}

async function getDirectAesKey(
  myId: string,
  peerId: string,
  opts?: { forcePeerRefresh?: boolean }
): Promise<CryptoKey | null> {
  const cacheKey = [myId, peerId].sort().join(':');
  if (!opts?.forcePeerRefresh && directKeyCache.has(cacheKey)) {
    return directKeyCache.get(cacheKey)!;
  }
  if (!privateKey || identityUserId !== myId) await ensureIdentityKeys(myId);
  if (!privateKey) return null;
  const peerPub = await fetchPeerPublicKey(peerId, { force: !!opts?.forcePeerRefresh });
  if (!peerPub) return null;
  try {
    const key = await deriveAesKey(privateKey, peerPub, directSalt(myId, peerId));
    directKeyCache.set(cacheKey, key);
    return key;
  } catch {
    return null;
  }
}

function wrapSalt(conversationId: string): string {
  return `pulse-group-wrap:${conversationId}`;
}

async function exportRawAesKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(raw);
}

async function persistConversationKey(
  myId: string,
  conversationId: string,
  key: CryptoKey
): Promise<void> {
  if (!myId || !conversationId) return;
  try {
    const raw = await exportRawAesKey(key);
    localStorage.setItem(convKeyStorage(myId, conversationId), b64urlEncode(raw));
  } catch {
    /* quota / private mode */
  }
}

async function loadPersistedConversationKey(
  myId: string,
  conversationId: string
): Promise<CryptoKey | null> {
  if (!myId || !conversationId) return null;
  try {
    const b64 = localStorage.getItem(convKeyStorage(myId, conversationId));
    if (!b64) return null;
    const raw = b64urlDecode(b64);
    const key = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(raw),
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    groupKeyCache.set(conversationId, key);
    return key;
  } catch {
    return null;
  }
}

async function rememberConversationKey(
  myId: string,
  conversationId: string,
  key: CryptoKey
): Promise<CryptoKey> {
  groupKeyCache.set(conversationId, key);
  void persistConversationKey(myId, conversationId, key);
  return key;
}

async function getGroupAesKey(
  conversation: Conversation,
  myId: string
): Promise<CryptoKey | null> {
  if (groupKeyCache.has(conversation.id)) return groupKeyCache.get(conversation.id)!;

  // Survives page refresh (in-memory cache alone does not)
  const persisted = await loadPersistedConversationKey(myId, conversation.id);
  if (persisted) return persisted;

  if (!privateKey || identityUserId !== myId) await ensureIdentityKeys(myId);
  if (!privateKey) return null;

  const wrapped = conversation.e2eWrappedKeys?.find((k) => sameId(k.userId, myId))
    ?.wrappedKey;
  if (!wrapped) return null;

  const salt = wrapSalt(conversation.id);

  // Self-wrapped (stable across peer key rotation if we restored our own identity)
  if (publicKey) {
    try {
      const key = await unwrapGroupKey(wrapped, privateKey, publicKey, salt);
      return rememberConversationKey(myId, conversation.id, key);
    } catch {
      /* not self-wrapped */
    }
  }

  // Wrapped by another member (ECDH with their current public key)
  const others = conversation.participants
    .map((p) => participantUserId(p))
    .filter((id): id is string => !!id && !sameId(id, myId));

  // Prefer cached peer pubs first (no network) — open-chat must stay offline-capable
  for (const peerId of others) {
    try {
      const peerPub = await fetchPeerPublicKey(peerId, { force: false });
      if (!peerPub) continue;
      const key = await unwrapGroupKey(wrapped, privateKey, peerPub, salt);
      return rememberConversationKey(myId, conversation.id, key);
    } catch {
      /* try next */
    }
  }
  // One network refresh only if unwrap still failed
  for (const peerId of others) {
    try {
      const peerPub = await fetchPeerPublicKey(peerId, { force: true });
      if (!peerPub) continue;
      const key = await unwrapGroupKey(wrapped, privateKey, peerPub, salt);
      return rememberConversationKey(myId, conversation.id, key);
    } catch {
      /* try next */
    }
  }

  return null;
}

async function pushWrappedKeys(
  conversation: Conversation,
  wrappedKeys: { userId: string; wrappedKey: string }[],
  versionHint?: number
): Promise<Conversation | null> {
  try {
    const res = await api.put(`/conversations/${conversation.id}/e2e-keys`, {
      wrappedKeys,
      version: versionHint ?? (conversation.e2eVersion || 0) + 1,
    });
    return extractData<{ conversation: Conversation }>(res).conversation;
  } catch {
    return null;
  }
}

/**
 * Ensure conversation has AES key wraps for E2E (groups + direct).
 * Direct chats use the same stable conversation key model so messages still
 * decrypt after identity restore (password backup) even if the peer's published
 * key changed since send time.
 *
 * Never overwrite existing wraps just because unwrap failed (would orphan history).
 */
export async function ensureGroupE2E(
  conversation: Conversation,
  myId: string
): Promise<Conversation | null> {
  return ensureConversationE2E(conversation, myId);
}

export async function ensureConversationE2E(
  conversation: Conversation,
  myId: string,
  opts?: { /** When false, only ensure local unwrap (no network redistributes). Default true. */
    redistribute?: boolean }
): Promise<Conversation | null> {
  if (!e2eSupported()) return conversation;
  await ensureIdentityKeys(myId);
  if (!privateKey || !publicKey) return null;

  const salt = wrapSalt(conversation.id);
  const mine = conversation.e2eWrappedKeys?.find((k) => sameId(k.userId, myId));
  const allowRedistribute = opts?.redistribute !== false;

  // Already have a wrap — load key; re-wrap peer only when missing or throttled refresh
  if (mine?.wrappedKey) {
    const key = await getGroupAesKey(conversation, myId);
    if (!key) {
      // Wrap exists but we cannot unwrap (identity lost without backup) — do not rekey
      return conversation;
    }

    // Opening a chat must not wait on redistributes (was the main open-chat stall)
    if (!allowRedistribute) return conversation;

    const peerId =
      conversation.type === 'direct' ? resolvePeerId(conversation, myId) : '';
    const peerHasWrap = peerId
      ? conversation.e2eWrappedKeys?.some((k) => sameId(k.userId, peerId) && k.wrappedKey)
      : true;
    const lastPush = lastWrapPushAt.get(conversation.id) || 0;
    const dueRefresh = Date.now() - lastPush > WRAP_PUSH_TTL_MS;
    // Only push when peer is missing a wrap, or occasionally refresh (not on every decrypt)
    const shouldPush = !peerHasWrap || dueRefresh;

    if (shouldPush && publicKey) {
      try {
        const raw = await exportRawAesKey(key);
        const toPush: { userId: string; wrappedKey: string }[] = [];
        // Self-wrap for restore resilience
        try {
          toPush.push({
            userId: myId,
            wrappedKey: await wrapGroupKey(raw, privateKey, publicKey, salt),
          });
        } catch {
          /* */
        }
        if (peerId) {
          const peerPub = await fetchPeerPublicKey(peerId, {
            force: !peerHasWrap,
          });
          if (peerPub) {
            try {
              toPush.push({
                userId: peerId,
                wrappedKey: await wrapGroupKey(raw, privateKey, peerPub, salt),
              });
            } catch {
              /* */
            }
          }
        }
        if (toPush.length) {
          const updated = await pushWrappedKeys(conversation, toPush);
          if (updated) {
            lastWrapPushAt.set(conversation.id, Date.now());
            conversation = updated;
          }
        }
      } catch {
        /* */
      }
    }
    return conversation;
  }

  // No wrap for me, but others have wraps — cannot invent a new conversation key
  // (would orphan their history). They must re-wrap for us (sender does this on send/open).
  const existingWraps = conversation.e2eWrappedKeys?.filter((k) => k.wrappedKey) || [];
  if (existingWraps.length > 0) {
    return conversation;
  }

  // Fresh conversation key — wrap for everyone we can
  const groupKeyRaw = crypto.getRandomValues(new Uint8Array(32));
  const groupKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(groupKeyRaw),
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  const wrappedKeys: { userId: string; wrappedKey: string }[] = [];
  const participants = conversation.participants.map((p) => p.user).filter(Boolean) as User[];

  for (const u of participants) {
    if (!u.id) continue;
    if (sameId(u.id, myId)) {
      const wk = await wrapGroupKey(groupKeyRaw, privateKey, publicKey, salt);
      wrappedKeys.push({ userId: u.id, wrappedKey: wk });
      continue;
    }
    let peerPub: CryptoKey | null = null;
    if (u.identityPublicKey) {
      try {
        peerPub = await importPublicKey(u.identityPublicKey);
        peerPubCache.set(u.id, {
          key: peerPub,
          b64: u.identityPublicKey,
          at: Date.now(),
        });
      } catch {
        peerPub = null;
      }
    }
    if (!peerPub) peerPub = await fetchPeerPublicKey(u.id, { force: true });
    if (!peerPub) continue;
    const wk = await wrapGroupKey(groupKeyRaw, privateKey, peerPub, salt);
    wrappedKeys.push({ userId: u.id, wrappedKey: wk });
  }

  // Direct: need at least self wrap (peer may get wrap later)
  if (wrappedKeys.length === 0) return conversation;
  if (conversation.type === 'direct' && !wrappedKeys.some((k) => sameId(k.userId, myId))) {
    return conversation;
  }

  const updated = await pushWrappedKeys(
    conversation,
    wrappedKeys,
    (conversation.e2eVersion || 0) + 1
  );
  if (updated) {
    await rememberConversationKey(myId, conversation.id, groupKey);
    return updated;
  }
  // Push failed — still keep key locally so we can decrypt our own sends after refresh
  await rememberConversationKey(myId, conversation.id, groupKey);
  return conversation;
}

function resolvePeerId(conversation: Conversation, myId: string): string {
  for (const p of conversation.participants || []) {
    const id = participantUserId(p);
    if (id && !sameId(id, myId)) return id;
  }
  return '';
}

/**
 * Resolve AES key for a conversation.
 * Prefers stable conversation wraps (direct + group). Falls back to legacy ECDH for old DMs.
 */
async function conversationAesKey(
  conversation: Conversation,
  myId: string,
  opts?: { forcePeerRefresh?: boolean }
): Promise<CryptoKey | null> {
  // Stable conversation key (wraps) — preferred for direct + group
  let key = await getGroupAesKey(conversation, myId);
  if (!key) {
    const mine = conversation.e2eWrappedKeys?.find((k) => sameId(k.userId, myId));
    // Initialize wraps only when none exist for me yet
    if (!mine?.wrappedKey) {
      const updated = await ensureConversationE2E(conversation, myId);
      if (updated) {
        key = await getGroupAesKey(updated, myId);
        if (key) return key;
      }
    }
  } else {
    return key;
  }

  // Legacy direct ECDH (pre-wrap messages / conversations)
  if (conversation.type === 'direct') {
    const peerId = resolvePeerId(conversation, myId);
    if (!peerId) return null;
    return getDirectAesKey(myId, peerId, opts);
  }
  return null;
}

/**
 * Encrypt plaintext for a conversation.
 * - isE2E true: ciphertext ready to send
 * - error set: do NOT send plaintext
 * - isE2E false, no error: peer has no keys — plaintext OK
 */
export async function encryptMessageContent(
  conversation: Conversation,
  myId: string,
  plaintext: string
): Promise<{ content: string; isE2E: boolean; error?: string; conversation?: Conversation }> {
  if (!plaintext) return { content: plaintext, isE2E: false };
  if (!e2eSupported()) {
    return { content: plaintext, isE2E: false };
  }
  try {
    await ensureIdentityKeys(myId);
    // Ensure wraps before encrypt (throttled redistributes — not every keystroke)
    const updated = await ensureConversationE2E(conversation, myId);
    if (updated) conversation = updated;
    const key = await conversationAesKey(conversation, myId);
    if (!key) {
      const expected = await encryptionExpected(conversation, myId);
      if (expected) {
        return {
          content: '',
          isE2E: false,
          error: 'Could not encrypt. Both users need keys — open Pulse on each device once.',
        };
      }
      return { content: plaintext, isE2E: false, conversation };
    }
    // Direct: peer must have a wrap entry or they will only see "Encrypted"
    if (conversation.type === 'direct') {
      const peerId = resolvePeerId(conversation, myId);
      const peerHasWrap = conversation.e2eWrappedKeys?.some(
        (k) => sameId(k.userId, peerId) && k.wrappedKey
      );
      if (peerId && !peerHasWrap) {
        // One more re-wrap attempt
        const again = await ensureConversationE2E(conversation, myId);
        if (again) conversation = again;
        const ok = conversation.e2eWrappedKeys?.some(
          (k) => sameId(k.userId, peerId) && k.wrappedKey
        );
        if (!ok) {
          return {
            content: '',
            isE2E: false,
            error:
              'Could not set up encryption for the other person. Ask them to open Pulse once, then try again.',
          };
        }
      }
    }
    // Always persist the key used for encrypt so *this device* can decrypt after reload
    await rememberConversationKey(myId, conversation.id, key);
    const content = await aesEncrypt(key, plaintext);
    return { content, isE2E: true, conversation };
  } catch {
    return {
      content: '',
      isE2E: false,
      error: 'Encryption failed. Message was not sent in plaintext.',
    };
  }
}

/** Safety number / key fingerprint for TOFU verification between two users */
export async function safetyNumber(myPubB64: string, theirPubB64: string): Promise<string> {
  const [a, b] = [myPubB64, theirPubB64].sort();
  const data = textEncoder.encode(`pulse-safety-v1:${a}:${b}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  // 12 groups of 5 digits for human comparison
  const parts: string[] = [];
  for (let i = 0; i < 12; i++) {
    const n = ((bytes[i * 2] << 8) | bytes[i * 2 + 1]) % 100000;
    parts.push(n.toString().padStart(5, '0'));
  }
  return parts.join(' ');
}

/** Encrypt binary media with conversation AES key (opaque blob for upload). */
export async function encryptMediaBlob(
  conversation: Conversation,
  myId: string,
  data: ArrayBuffer
): Promise<{ blob: Blob; meta: string } | null> {
  try {
    await ensureIdentityKeys();
    const key = await conversationAesKey(conversation, myId);
    if (!key) return null;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    const meta = `e2e-media:1:${b64urlEncode(iv)}`;
    return { blob: new Blob([ct], { type: 'application/octet-stream' }), meta };
  } catch {
    return null;
  }
}

export async function decryptMediaBlob(
  conversation: Conversation,
  myId: string,
  data: ArrayBuffer,
  meta: string
): Promise<ArrayBuffer | null> {
  try {
    if (!meta.startsWith('e2e-media:1:')) return null;
    const ivB64 = meta.slice('e2e-media:1:'.length);
    await ensureIdentityKeys();
    const key = await conversationAesKey(conversation, myId);
    if (!key) return null;
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(b64urlDecode(ivB64)) },
      key,
      data
    );
  } catch {
    return null;
  }
}

async function encryptionExpected(
  conversation: Conversation,
  myId: string
): Promise<boolean> {
  if ((conversation.e2eVersion || 0) > 0 || (conversation.e2eWrappedKeys?.length || 0) > 0) {
    return true;
  }
  if (conversation.type === 'group') return false;
  const peerId = resolvePeerId(conversation, myId);
  if (!peerId) return false;
  const peer = conversation.participants.find((p) => sameId(participantUserId(p), peerId))
    ?.user;
  if (peer && typeof peer === 'object' && peer.identityPublicKey) return true;
  return !!(await fetchPeerPublicKey(peerId));
}

/**
 * Decrypt a message body.
 * - Never replaces normal plaintext with the lock placeholder.
 * - Only shows LOCKED when content is a real E2E envelope we cannot decrypt.
 */
export async function decryptMessageContent(
  conversation: Conversation | undefined | null,
  myId: string,
  content: string,
  _isE2E?: boolean
): Promise<string> {
  if (!content) return content;

  const looksEncrypted = isE2ECiphertext(content);

  // Not encrypted → always return as-is (ignore stale isE2E flags)
  if (!looksEncrypted) {
    return content;
  }

  if (!e2eSupported()) return LOCKED;
  if (!conversation || !myId) return LOCKED;

  // Lightweight decrypt only — do NOT network on every message (rate-limit storm).
  // ensureConversationE2E is called once when opening a chat / sending.
  try {
    await ensureIdentityKeys(myId);
    let key = await conversationAesKey(conversation, myId, {
      forcePeerRefresh: false,
    });
    // Retry: drop bad in-memory cache and reload durable key / re-unwrap
    if (!key) {
      groupKeyCache.delete(conversation.id);
      key = await conversationAesKey(conversation, myId, {
        forcePeerRefresh: true,
      });
    }
    if (key) {
      try {
        const plain = await aesDecrypt(key, content);
        if (plain && !isE2ECiphertext(plain)) {
          void rememberConversationKey(myId, conversation.id, key);
          return plain;
        }
      } catch {
        // Wrong key cached — clear and try once more from wraps / peer
        groupKeyCache.delete(conversation.id);
        try {
          localStorage.removeItem(convKeyStorage(myId, conversation.id));
        } catch {
          /* */
        }
        const key2 = await conversationAesKey(conversation, myId, {
          forcePeerRefresh: true,
        });
        if (key2) {
          const plain2 = await aesDecrypt(key2, content);
          if (plain2 && !isE2ECiphertext(plain2)) {
            void rememberConversationKey(myId, conversation.id, key2);
            return plain2;
          }
        }
      }
    }
  } catch {
    /* try legacy */
  }

  // Legacy ECDH fallback for older DMs without wraps
  if (conversation.type === 'direct') {
    try {
      const peerId = resolvePeerId(conversation, myId);
      if (peerId) {
        directKeyCache.delete([myId, peerId].sort().join(':'));
        const legacy = await getDirectAesKey(myId, peerId, { forcePeerRefresh: true });
        if (legacy) {
          const p = await aesDecrypt(legacy, content);
          if (p && !isE2ECiphertext(p)) return p;
        }
      }
    } catch {
      /* */
    }
  }
  return LOCKED;
}

/**
 * Decrypt lastMessage previews on the conversation list (sidebar).
 * Chat view already decrypts full threads; list rows were left as ciphertext.
 */
export async function decryptConversationPreviews(
  conversations: Conversation[],
  myId: string
): Promise<Conversation[]> {
  if (!conversations.length || !myId) return conversations;
  try {
    await ensureIdentityKeys(myId);
  } catch {
    /* */
  }

  const results: Conversation[] = [];
  for (const c of conversations) {
    const lm = c.lastMessage as Message | undefined;
    if (!lm || typeof lm !== 'object' || !isE2ECiphertext(lm.content)) {
      results.push(c);
      continue;
    }
    try {
      const content = await decryptMessageContent(c, myId, lm.content || '');
      results.push({
        ...c,
        lastMessage: {
          ...lm,
          content,
          // Keep flag only if still ciphertext (failed decrypt → locked placeholder)
          isE2E: isE2ECiphertext(content) || content.startsWith('🔒'),
        },
      });
    } catch {
      results.push(c);
    }
  }
  return results;
}

/**
 * Decrypt a ciphertext body with a pre-warmed AES key (no network).
 * Falls back to full decrypt path only if key misses or AES fails.
 */
async function decryptWithWarmedKey(
  key: CryptoKey | null,
  conversation: Conversation | undefined | null,
  myId: string,
  content: string
): Promise<string> {
  if (!content || !isE2ECiphertext(content)) return content || '';
  if (key) {
    try {
      const plain = await aesDecrypt(key, content);
      if (plain && !isE2ECiphertext(plain)) return plain;
    } catch {
      /* try full path */
    }
  }
  return decryptMessageContent(conversation, myId, content, true);
}

/** Decrypt an array of messages (returns new array). Parallel + single key warm. */
export async function decryptMessages(
  conversation: Conversation | undefined | null,
  myId: string,
  messages: Message[]
): Promise<Message[]> {
  if (!messages.length || !myId) return messages;

  try {
    await ensureIdentityKeys(myId);
  } catch {
    /* */
  }

  let warmKey: CryptoKey | null = null;
  let conv = conversation;
  if (conv) {
    try {
      // Local unwrap only — never block decrypt on peer redistributes
      const ensured = await ensureConversationE2E(conv, myId, { redistribute: false });
      if (ensured) conv = ensured;
      warmKey = await conversationAesKey(conv, myId, { forcePeerRefresh: false });
      // Durable device key — critical after hard refresh
      if (!warmKey) {
        warmKey = await loadPersistedConversationKey(myId, conv.id);
      }
    } catch {
      warmKey = null;
    }
  }

  const anyCipher = messages.some(
    (m) =>
      isE2ECiphertext(m.content) ||
      (m.replyTo &&
        typeof m.replyTo === 'object' &&
        isE2ECiphertext((m.replyTo as Message).content))
  );
  if (!anyCipher) {
    return messages.map((m) => (m.isE2E ? { ...m, isE2E: false } : m));
  }

  // If we still have no key but wraps might be on the server, one full ensure with redistribute
  if (!warmKey && conv) {
    try {
      const ensured = await ensureConversationE2E(conv, myId, { redistribute: true });
      if (ensured) conv = ensured;
      warmKey = await conversationAesKey(conv, myId, { forcePeerRefresh: true });
    } catch {
      /* */
    }
  }

  return Promise.all(
    messages.map(async (m) => {
      if (m.type === 'system' || m.isDeleted) return m;

      const contentLooksE2E = isE2ECiphertext(m.content);
      let replyLooksE2E = false;
      if (m.replyTo && typeof m.replyTo === 'object') {
        replyLooksE2E = isE2ECiphertext((m.replyTo as Message).content);
      }

      if (!contentLooksE2E && !replyLooksE2E) {
        return contentLooksE2E || m.isE2E ? { ...m, isE2E: false } : m;
      }

      const content = contentLooksE2E
        ? await decryptWithWarmedKey(warmKey, conv, myId, m.content || '')
        : m.content || '';

      let replyTo = m.replyTo;
      if (replyTo && typeof replyTo === 'object') {
        const rt = replyTo as Message;
        if (isE2ECiphertext(rt.content)) {
          const rc = await decryptWithWarmedKey(warmKey, conv, myId, rt.content || '');
          replyTo = { ...rt, content: rc };
        }
      }

      return { ...m, content, replyTo };
    })
  );
}

/**
 * Warm identity + conversation key for a chat (no network redistributes).
 * Call on hover/pointerdown so open-chat decrypt is instant.
 */
export async function warmConversationCrypto(
  conversation: Conversation | undefined | null,
  myId: string
): Promise<void> {
  if (!conversation || !myId || !e2eSupported()) return;
  try {
    await ensureIdentityKeys(myId);
    await ensureConversationE2E(conversation, myId, { redistribute: false });
    await conversationAesKey(conversation, myId, { forcePeerRefresh: false });
  } catch {
    /* best-effort */
  }
}

/** Clear in-memory keys (logout). Does not wipe per-user device keystore. */
export function clearE2ESessionCaches(): void {
  privateKey = null;
  publicKey = null;
  publicKeyB64 = '';
  identityUserId = '';
  peerPubCache.clear();
  directKeyCache.clear();
  groupKeyCache.clear();
}

/** Remove durable conversation AES keys for a user (call on logout of that account). */
export function clearPersistedConversationKeys(userId?: string): void {
  try {
    const prefix = userId ? `pulse_e2e_conv_aes:${userId}:` : 'pulse_e2e_conv_aes:';
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* */
  }
}

/** Wipe device identity keys for the current (or given) user. */
export function wipeE2EDeviceKeys(userId?: string): void {
  const uid = resolveUserId(userId);
  clearE2ESessionCaches();
  try {
    if (uid) {
      localStorage.removeItem(privKeyStorage(uid));
      localStorage.removeItem(pubKeyStorage(uid));
    }
    localStorage.removeItem(PRIV_KEY_LEGACY);
    localStorage.removeItem(PUB_KEY_LEGACY);
  } catch {
    /* */
  }
}
