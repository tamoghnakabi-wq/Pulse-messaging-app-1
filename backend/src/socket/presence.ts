import type { Server } from 'socket.io';
import { User } from '../models/User';
import { Conversation } from '../models/Conversation';
import logger from '../utils/logger';
import { contactsCache } from '../utils/ttlCache';
import { getActiveCallForUser } from '../services/call/groupCall.registry';
import { getDirectCallForUser } from '../services/call/directCall.registry';

// userId -> Set of socket ids (multi-tab / multi-device)
export const onlineUsers = new Map<string, Set<string>>();
// userId -> last presence activity (ms)
export const lastHeartbeat = new Map<string, number>();
// conversationId -> Map userId -> timeout
export const typingUsers = new Map<string, Map<string, NodeJS.Timeout>>();

// Longer grace: iOS Safari pauses the WebSocket for bfcache on app-switch.
// Too short → flash offline for contacts on every Safari exit.
export const OFFLINE_GRACE_MS = 25_000;
export const HEARTBEAT_STALE_MS = 90_000;

const pendingOffline = new Map<string, ReturnType<typeof setTimeout>>();

let presenceSweeper: ReturnType<typeof setInterval> | null = null;

export function isUserOnline(userId: string): boolean {
  return (onlineUsers.get(userId)?.size || 0) > 0;
}

export function getOnlineUserIds(): string[] {
  return Array.from(onlineUsers.keys()).filter((id) => (onlineUsers.get(id)?.size || 0) > 0);
}

/** Clear stale isOnline flags in DB on boot (safe — no data deleted). */
export async function resetPresenceOnBoot(): Promise<void> {
  const result = await User.updateMany(
    { isOnline: true },
    { $set: { isOnline: false, lastSeen: new Date() } }
  );
  if (result.modifiedCount > 0) {
    logger.info(`Presence reset on boot: cleared ${result.modifiedCount} stale online flag(s)`);
  }
}

export async function markUserOffline(
  io: Server | null,
  userId: string
): Promise<void> {
  if (isUserOnline(userId)) return;
  const lastSeen = new Date();
  lastHeartbeat.delete(userId);
  await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen });
  void emitPresenceToContacts(io, userId, 'user:offline', {
    userId,
    isOnline: false,
    lastSeen,
  });
  logger.info(`User offline: ${userId}`);
}

export function scheduleOffline(io: Server | null, userId: string): void {
  const existing = pendingOffline.get(userId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingOffline.delete(userId);
    void markUserOffline(io, userId);
  }, OFFLINE_GRACE_MS);
  pendingOffline.set(userId, t);
}

export function cancelScheduledOffline(userId: string): void {
  const t = pendingOffline.get(userId);
  if (t) {
    clearTimeout(t);
    pendingOffline.delete(userId);
  }
}

export function touchPresence(userId: string): void {
  lastHeartbeat.set(userId, Date.now());
}

/** Notify presence only to users who share a conversation (not global broadcast). */
export async function emitPresenceToContacts(
  io: Server | null,
  userId: string,
  event: 'user:online' | 'user:offline',
  payload: Record<string, unknown>
): Promise<void> {
  if (!io) return;
  let contactIds = contactsCache.get(userId);
  if (!contactIds) {
    const convs = await Conversation.find({
      'participants.user': userId,
      isActive: true,
    })
      .select('participants.user')
      .lean();

    const contacts = new Set<string>();
    for (const c of convs) {
      for (const p of c.participants || []) {
        const id = String(p.user);
        if (id !== userId) contacts.add(id);
      }
    }
    contactIds = Array.from(contacts);
    contactsCache.set(userId, contactIds);
  }
  for (const contactId of contactIds) {
    io.to(`user:${contactId}`).emit(event, payload);
  }
}

/** Remove dead socket ids and fix DB for anyone marked online without a live socket. */
export async function sweepPresence(io: Server | null): Promise<void> {
  if (!io) return;

  for (const [userId, sockets] of onlineUsers.entries()) {
    for (const sid of [...sockets]) {
      const s = io.sockets.sockets.get(sid);
      if (!s || !s.connected) {
        sockets.delete(sid);
      }
    }
    if (sockets.size === 0) {
      onlineUsers.delete(userId);
      if (!pendingOffline.has(userId)) {
        void markUserOffline(io, userId);
      }
    } else {
      const hb = lastHeartbeat.get(userId) || 0;
      if (hb && Date.now() - hb > HEARTBEAT_STALE_MS) {
        // Never force-disconnect mid-call — media may keep the socket alive without pings
        if (getActiveCallForUser(userId) || getDirectCallForUser(userId)) {
          touchPresence(userId);
          continue;
        }
        for (const sid of [...sockets]) {
          io.sockets.sockets.get(sid)?.disconnect(true);
        }
        onlineUsers.delete(userId);
        lastHeartbeat.delete(userId);
        void markUserOffline(io, userId);
      }
    }
  }

  const liveIds = getOnlineUserIds();
  const stale = await User.find({
    isOnline: true,
    ...(liveIds.length ? { _id: { $nin: liveIds } } : {}),
  })
    .select('_id')
    .lean();

  if (stale.length) {
    const ids = stale.map((u) => u._id);
    await User.updateMany(
      { _id: { $in: ids } },
      { $set: { isOnline: false, lastSeen: new Date() } }
    );
    for (const id of ids) {
      void emitPresenceToContacts(io, String(id), 'user:offline', {
        userId: String(id),
        isOnline: false,
        lastSeen: new Date(),
      });
    }
    logger.info(`Presence sweeper: fixed ${stale.length} stale online user(s)`);
  }
}

export function startPresenceSweeper(io: Server): void {
  if (presenceSweeper) clearInterval(presenceSweeper);
  presenceSweeper = setInterval(() => {
    void sweepPresence(io);
  }, 15_000);
}

export function stopPresenceSweeper(): void {
  if (presenceSweeper) {
    clearInterval(presenceSweeper);
    presenceSweeper = null;
  }
}
