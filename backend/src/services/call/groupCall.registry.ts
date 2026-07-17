/**
 * In-memory multi-party call sessions (PCM/JPEG relay rooms).
 * Ephemeral — lost on process restart (same as live 1:1 media path).
 */

export type GroupMemberStatus = 'invited' | 'joined' | 'left' | 'rejected';

export interface GroupCallMember {
  userId: string;
  status: GroupMemberStatus;
  joinedAt?: number;
}

export interface GroupCallSession {
  callId: string;
  conversationId: string;
  callType: string;
  initiatorId: string;
  members: Map<string, GroupCallMember>;
  createdAt: number;
}

const sessions = new Map<string, GroupCallSession>();
/** userId → callId for users currently invited or joined (one active call at a time). */
const userActiveCall = new Map<string, string>();

const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

function touchUser(userId: string, callId: string | null) {
  if (!callId) userActiveCall.delete(userId);
  else userActiveCall.set(userId, callId);
}

function pruneStale() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      destroySession(id);
    }
  }
}

export function getGroupSession(callId: string): GroupCallSession | undefined {
  return sessions.get(callId);
}

export function getActiveCallForUser(userId: string): string | undefined {
  return userActiveCall.get(userId);
}

export function createGroupSession(opts: {
  callId: string;
  conversationId: string;
  callType: string;
  initiatorId: string;
  inviteUserIds: string[];
}): GroupCallSession | null {
  pruneStale();
  const existing = sessions.get(opts.callId);
  // Never hijack another room — client-supplied callId collision
  if (existing) return null;

  const members = new Map<string, GroupCallMember>();
  members.set(opts.initiatorId, {
    userId: opts.initiatorId,
    status: 'joined',
    joinedAt: Date.now(),
  });
  touchUser(opts.initiatorId, opts.callId);

  for (const uid of opts.inviteUserIds) {
    if (!uid || uid === opts.initiatorId) continue;
    if (members.has(uid)) continue;
    members.set(uid, { userId: uid, status: 'invited' });
    touchUser(uid, opts.callId);
  }

  const session: GroupCallSession = {
    callId: opts.callId,
    conversationId: opts.conversationId,
    callType: opts.callType || 'audio',
    initiatorId: opts.initiatorId,
    members,
    createdAt: Date.now(),
  };
  sessions.set(opts.callId, session);
  return session;
}

export function inviteToGroupSession(
  callId: string,
  inviteUserIds: string[]
): { session: GroupCallSession; newlyInvited: string[] } | null {
  const session = sessions.get(callId);
  if (!session) return null;
  const newlyInvited: string[] = [];
  for (const uid of inviteUserIds) {
    if (!uid || uid === session.initiatorId) continue;
    const existing = session.members.get(uid);
    if (existing?.status === 'joined' || existing?.status === 'invited') continue;
    session.members.set(uid, { userId: uid, status: 'invited' });
    touchUser(uid, callId);
    newlyInvited.push(uid);
  }
  return { session, newlyInvited };
}

export function acceptGroupSession(callId: string, userId: string): GroupCallSession | null {
  const session = sessions.get(callId);
  if (!session) return null;
  const m = session.members.get(userId);
  if (!m || (m.status !== 'invited' && m.status !== 'joined')) return null;
  m.status = 'joined';
  m.joinedAt = Date.now();
  touchUser(userId, callId);
  return session;
}

export function rejectGroupSession(callId: string, userId: string): GroupCallSession | null {
  const session = sessions.get(callId);
  if (!session) return null;
  const m = session.members.get(userId);
  // Only real invitees can reject — ignore forgeries
  if (!m || m.status !== 'invited') return null;
  m.status = 'rejected';
  if (userActiveCall.get(userId) === callId) touchUser(userId, null);
  return session;
}

/**
 * Leave a group call. Returns whether the whole session was destroyed.
 * When destroyed, `notifyIds` lists everyone who was still on the roster.
 */
export function leaveGroupSession(
  callId: string,
  userId: string
): {
  session: GroupCallSession | null;
  destroyed: boolean;
  remainingJoined: string[];
  notifyIds: string[];
} {
  const session = sessions.get(callId);
  if (!session) {
    if (userActiveCall.get(userId) === callId) touchUser(userId, null);
    return { session: null, destroyed: true, remainingJoined: [], notifyIds: [] };
  }
  const m = session.members.get(userId);
  if (m) m.status = 'left';
  if (userActiveCall.get(userId) === callId) touchUser(userId, null);

  const remainingJoined = [...session.members.values()]
    .filter((x) => x.status === 'joined')
    .map((x) => x.userId);

  // End room when nobody is left connected
  if (remainingJoined.length === 0) {
    const notifyIds = [...session.members.keys()].filter((id) => id !== userId);
    destroySession(callId);
    return { session: null, destroyed: true, remainingJoined: [], notifyIds };
  }
  return {
    session,
    destroyed: false,
    remainingJoined,
    notifyIds: remainingJoined,
  };
}

export function endGroupSession(callId: string): string[] {
  const session = sessions.get(callId);
  if (!session) return [];
  const notified = [...session.members.keys()];
  destroySession(callId);
  return notified;
}

function destroySession(callId: string) {
  const session = sessions.get(callId);
  if (!session) return;
  for (const uid of session.members.keys()) {
    if (userActiveCall.get(uid) === callId) touchUser(uid, null);
  }
  sessions.delete(callId);
}

export function isJoinedMember(callId: string, userId: string): boolean {
  const s = sessions.get(callId);
  if (!s) return false;
  return s.members.get(userId)?.status === 'joined';
}

export function isSessionMember(callId: string, userId: string): boolean {
  const s = sessions.get(callId);
  if (!s) return false;
  const st = s.members.get(userId)?.status;
  return st === 'joined' || st === 'invited';
}

export function joinedMemberIds(callId: string): string[] {
  const s = sessions.get(callId);
  if (!s) return [];
  return [...s.members.values()].filter((m) => m.status === 'joined').map((m) => m.userId);
}

export function rosterPayload(session: GroupCallSession) {
  return {
    callId: session.callId,
    conversationId: session.conversationId,
    callType: session.callType,
    initiatorId: session.initiatorId,
    members: [...session.members.values()].map((m) => ({
      userId: m.userId,
      status: m.status,
    })),
  };
}
