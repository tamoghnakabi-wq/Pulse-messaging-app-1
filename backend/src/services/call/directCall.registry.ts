/**
 * In-memory 1:1 call pairs — gates media relay so only participants of an
 * active (or recently ringing) call can stream PCM/JPEG to each other.
 */

export type DirectCallPhase = 'ringing' | 'active';

interface DirectCall {
  callId: string;
  a: string;
  b: string;
  phase: DirectCallPhase;
  updatedAt: number;
}

const byPair = new Map<string, DirectCall>();
const byCallId = new Map<string, string>(); // callId → pairKey
/** Brief allow after hangup so last frames drain */
const drainUntil = new Map<string, number>();
const DRAIN_MS = 3_000;
const RINGING_TTL_MS = 90_000;
const ACTIVE_TTL_MS = 4 * 60 * 60 * 1000;

function pairKey(userA: string, userB: string): string {
  return userA < userB ? `${userA}:${userB}` : `${userB}:${userA}`;
}

function prune() {
  const now = Date.now();
  for (const [k, c] of byPair) {
    const ttl = c.phase === 'ringing' ? RINGING_TTL_MS : ACTIVE_TTL_MS;
    if (now - c.updatedAt > ttl) {
      byPair.delete(k);
      byCallId.delete(c.callId);
    }
  }
  for (const [k, until] of drainUntil) {
    if (now > until) drainUntil.delete(k);
  }
}

export function registerDirectRinging(
  callId: string,
  initiatorId: string,
  peerId: string
): void {
  prune();
  const key = pairKey(initiatorId, peerId);
  const prev = byPair.get(key);
  if (prev) byCallId.delete(prev.callId);
  const entry: DirectCall = {
    callId,
    a: initiatorId < peerId ? initiatorId : peerId,
    b: initiatorId < peerId ? peerId : initiatorId,
    phase: 'ringing',
    updatedAt: Date.now(),
  };
  byPair.set(key, entry);
  byCallId.set(callId, key);
  drainUntil.delete(key);
}

export function markDirectActive(callId: string): void {
  const key = byCallId.get(callId);
  if (!key) return;
  const c = byPair.get(key);
  if (!c) return;
  c.phase = 'active';
  c.updatedAt = Date.now();
}

export function clearDirectCall(callId: string): void {
  const key = byCallId.get(callId);
  if (!key) return;
  byPair.delete(key);
  byCallId.delete(callId);
  drainUntil.set(key, Date.now() + DRAIN_MS);
}

export function clearDirectPair(userA: string, userB: string): void {
  const key = pairKey(userA, userB);
  const c = byPair.get(key);
  if (c) {
    byCallId.delete(c.callId);
    byPair.delete(key);
  }
  drainUntil.set(key, Date.now() + DRAIN_MS);
}

/** True if these two users have a live or just-ended (drain) 1:1 call. */
export function isActiveDirectPair(
  userA: string,
  userB: string,
  callId?: string
): boolean {
  prune();
  const key = pairKey(userA, userB);
  const c = byPair.get(key);
  if (c) {
    if (callId && c.callId !== callId) return false;
    const ttl = c.phase === 'ringing' ? RINGING_TTL_MS : ACTIVE_TTL_MS;
    return Date.now() - c.updatedAt < ttl;
  }
  const until = drainUntil.get(key);
  return !!until && Date.now() < until;
}

export function getDirectCallForUser(userId: string): DirectCall | null {
  prune();
  for (const c of byPair.values()) {
    if (c.a === userId || c.b === userId) return c;
  }
  return null;
}
