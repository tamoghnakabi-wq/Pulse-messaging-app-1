import type { Server, Socket } from 'socket.io';
import logger from '../../utils/logger';
import { isObjectIdString } from '../../utils/sanitize';
import {
  listConversationParticipantIds,
  conversationHasUser,
  usersShareDirectConversation,
} from '../../services/conversation/conversationAccess.service';
import {
  recordCallAccepted,
  recordCallEnded,
  recordCallRejected,
  recordCallStart,
} from '../../services/call/callLog.service';
import {
  acceptGroupSession,
  createGroupSession,
  endGroupSession,
  getGroupSession,
  inviteToGroupSession,
  isJoinedMember,
  isSessionMember,
  joinedMemberIds,
  leaveGroupSession,
  rejectGroupSession,
  rosterPayload,
} from '../../services/call/groupCall.registry';
import {
  clearDirectCall,
  isActiveDirectPair,
  markDirectActive,
  registerDirectRinging,
} from '../../services/call/directCall.registry';
import { createSocketRateLimiter } from '../rateLimit';
import { touchPresence } from '../presence';

interface AuthedSocket extends Socket {
  userId?: string;
}

// Audio ~25 pkt/s + screen/video up to ~28 fps both ways.
// Cap higher so one direction isn't starved when video + audio share the bucket
// (was 120 — under tunnel bursts audio packets were dropped → one-way voice).
const allowMedia = createSocketRateLimiter(180);
/** Soft cap on concurrent invitees per group call start/invite. */
const MAX_GROUP_INVITES = 12;

/**
 * Register call signaling + media-relay handlers for a connected socket.
 * Supports 1:1 (targetUserId) and multi-party group rooms (callId + group).
 */
export function registerCallHandlers(io: Server, socket: AuthedSocket): void {
  const userId = socket.userId!;

  const relayCall = (
    event: string,
    payload: Record<string, unknown> | null | undefined
  ) => {
    if (!payload || typeof payload !== 'object') return;
    const target = String(payload.targetUserId || '');
    if (!target || target === userId) {
      logger.warn(`call relay dropped (${event}): target=${target} from=${userId}`);
      return;
    }
    const { targetUserId: _t, ...rest } = payload;
    const room = `user:${target}`;
    // Debug, not info: this fires for every ICE candidate. At info level a
    // single call produced dozens of lines and the room-size lookup ran on the
    // signaling hot path for nothing. Call milestones are logged by their own
    // handlers below.
    if (process.env.NODE_ENV !== 'production') {
      const size = io.sockets.adapter.rooms.get(room)?.size || 0;
      logger.debug(`call relay ${event}: ${userId} → ${target} (room size ${size})`);
    }
    io.to(room).emit(event, { ...rest, fromUserId: userId });
  };

  const emitToUser = (target: string, event: string, payload: Record<string, unknown>) => {
    if (!target || target === userId) return;
    io.to(`user:${target}`).emit(event, { ...payload, fromUserId: userId });
  };

  const emitToUsers = (
    targets: string[],
    event: string,
    payload: Record<string, unknown>,
    except?: string
  ) => {
    for (const t of targets) {
      if (!t || t === except) continue;
      io.to(`user:${t}`).emit(event, { ...payload, fromUserId: userId });
    }
  };

  /** Full check for starting a call (block + privacy). */
  const assertCanCallTarget = async (target: string): Promise<boolean> => {
    if (!target || target === userId || !isObjectIdString(target)) return false;
    const shared = await usersShareDirectConversation(userId, target);
    if (!shared) return false;
    try {
      const { isEitherBlocked } = await import('../../controllers/moderation.controller');
      if (await isEitherBlocked(userId, target)) return false;
      const { User } = await import('../../models/User');
      const peer = await User.findById(target).select('settings.privacy').lean();
      const audience = peer?.settings?.privacy?.calls || 'everyone';
      if (audience === 'nobody') return false;
      // contacts | everyone: shared direct conversation already implies contact
    } catch {
      return false;
    }
    return true;
  };

  /**
   * Hangup / reject / ICE during an in-progress call.
   * Must still work if peer blocked mid-call (privacy must not trap the peer).
   */
  const assertCanSignalInCall = async (target: string): Promise<boolean> => {
    if (!target || target === userId || !isObjectIdString(target)) return false;
    return usersShareDirectConversation(userId, target);
  };

  const filterCallableInvitees = async (
    conversationId: string,
    inviteUserIds: unknown
  ): Promise<string[]> => {
    if (!Array.isArray(inviteUserIds)) return [];
    const convMembers = new Set(await listConversationParticipantIds(conversationId));
    if (!convMembers.has(userId)) return [];

    const raw = inviteUserIds
      .map((x) => String(x || ''))
      .filter((id) => id && id !== userId && isObjectIdString(id) && convMembers.has(id));

    const unique = [...new Set(raw)].slice(0, MAX_GROUP_INVITES);
    if (!unique.length) return [];

    try {
      const { isEitherBlocked } = await import('../../controllers/moderation.controller');
      const { User } = await import('../../models/User');
      const allowed: string[] = [];
      for (const id of unique) {
        if (await isEitherBlocked(userId, id)) continue;
        const peer = await User.findById(id).select('settings.privacy').lean();
        const audience = peer?.settings?.privacy?.calls || 'everyone';
        if (audience === 'nobody') continue;
        allowed.push(id);
      }
      return allowed;
    } catch {
      // Fail closed — same as 1:1 assertCanCallTarget
      return [];
    }
  };

  // ─── 1:1 signaling (unchanged wire format) ───────────────────────

  socket.on('call:initiate', async (payload: Record<string, unknown>) => {
    logger.info(`call:initiate from ${userId}`, {
      target: payload?.targetUserId,
      callType: payload?.callType,
      preferRelay: payload?.preferRelay,
    });
    if (!payload?.targetUserId) {
      logger.warn('call:initiate missing targetUserId');
      socket.emit('call:error', { message: 'Invalid call initiate payload' });
      return;
    }
    const target = String(payload.targetUserId);
    if (!(await assertCanCallTarget(target))) {
      socket.emit('call:error', { message: 'Not allowed to call this user' });
      return;
    }
    const callId = String(payload.callId || `${userId}-${Date.now()}`);
    registerDirectRinging(callId, userId, target);
    void recordCallStart({
      callId,
      initiatorId: userId,
      peerId: target,
      conversationId: payload.conversationId ? String(payload.conversationId) : undefined,
      callType: String(payload.callType || 'audio'),
    });
    relayCall('call:incoming', {
      conversationId: payload.conversationId,
      callType: payload.callType || 'audio',
      sdpOffer: payload.sdpOffer,
      callId,
      preferRelay: payload.preferRelay ?? true,
      targetUserId: target,
      group: false,
    });
  });

  socket.on('call:accept', (payload: Record<string, unknown>) => {
    void (async () => {
      logger.info(`call:accept from ${userId} → ${payload?.targetUserId}`);
      if (!payload?.targetUserId) return;
      const target = String(payload.targetUserId);
      if (!(await assertCanCallTarget(target))) return;
      if (payload.callId) {
        // Ensure pair exists even after server restart mid-ring
        registerDirectRinging(String(payload.callId), userId, target);
        markDirectActive(String(payload.callId));
        void recordCallAccepted(String(payload.callId));
      }
      relayCall('call:answer', {
        callId: payload.callId,
        sdpAnswer: payload.sdpAnswer,
        preferRelay: payload.preferRelay ?? true,
        targetUserId: target,
      });
    })();
  });

  socket.on('call:reject', (payload: Record<string, unknown>) => {
    void (async () => {
      const target = String(payload?.targetUserId || '');
      if (!(await assertCanSignalInCall(target))) return;
      logger.info(`call:reject from ${userId}`);
      if (payload?.callId) {
        clearDirectCall(String(payload.callId));
        void recordCallRejected(String(payload.callId));
      }
      relayCall('call:rejected', {
        callId: payload?.callId,
        targetUserId: target,
      });
    })();
  });

  socket.on('call:end', (payload: Record<string, unknown>) => {
    void (async () => {
      const target = String(payload?.targetUserId || '');
      if (!(await assertCanSignalInCall(target))) return;
      logger.info(`call:end from ${userId}`);
      if (payload?.callId) {
        clearDirectCall(String(payload.callId));
        void recordCallEnded(String(payload.callId));
      }
      relayCall('call:ended', {
        callId: payload?.callId,
        targetUserId: target,
      });
    })();
  });

  socket.on('call:ice-candidate', (payload: Record<string, unknown>) => {
    void (async () => {
      if (!payload?.candidate) return;
      const target = String(payload?.targetUserId || '');
      if (!(await assertCanSignalInCall(target))) return;
      relayCall('call:ice-candidate', {
        ...payload,
        targetUserId: target,
      });
    })();
  });

  socket.on('call:answer', (payload: Record<string, unknown>) => {
    void (async () => {
      const target = String(payload?.targetUserId || '');
      // Answer is still a join action — keep full privacy for who may accept
      if (!(await assertCanCallTarget(target))) return;
      relayCall('call:answer', {
        ...payload,
        targetUserId: target,
      });
    })();
  });

  // ─── Group / multi-party ─────────────────────────────────────────

  socket.on('call:group:start', async (payload: Record<string, unknown>) => {
    const conversationId = String(payload?.conversationId || '');
    const callType = String(payload?.callType || 'audio');
    const callId = String(payload?.callId || `gcall_${Date.now()}_${userId.slice(-4)}`);

    if (!conversationId || !(await conversationHasUser(conversationId, userId))) {
      socket.emit('call:error', { message: 'Not a member of this conversation' });
      return;
    }

    const inviteUserIds = await filterCallableInvitees(conversationId, payload?.inviteUserIds);
    if (!inviteUserIds.length) {
      socket.emit('call:error', { message: 'Select at least one member to call' });
      return;
    }

    const session = createGroupSession({
      callId,
      conversationId,
      callType,
      initiatorId: userId,
      inviteUserIds,
    });
    if (!session) {
      socket.emit('call:error', { message: 'Call id already in use — try again' });
      return;
    }

    const peerId = inviteUserIds[0];
    void recordCallStart({
      callId,
      initiatorId: userId,
      peerId,
      conversationId,
      callType,
    });

    const roster = rosterPayload(session);
    // Confirm to host
    socket.emit('call:group:roster', roster);

    for (const target of inviteUserIds) {
      emitToUser(target, 'call:group:incoming', {
        callId,
        conversationId,
        callType,
        initiatorId: userId,
        inviteUserIds: [userId, ...inviteUserIds],
        members: roster.members,
        group: true,
      });
    }

    logger.info(`call:group:start ${callId} by ${userId} invites=${inviteUserIds.length}`);
  });

  socket.on('call:group:invite', async (payload: Record<string, unknown>) => {
    const callId = String(payload?.callId || '');
    const session = getGroupSession(callId);
    if (!session || !isJoinedMember(callId, userId)) {
      socket.emit('call:error', { message: 'Not in this group call' });
      return;
    }

    const inviteUserIds = await filterCallableInvitees(
      session.conversationId,
      payload?.inviteUserIds
    );
    if (!inviteUserIds.length) return;

    const result = inviteToGroupSession(callId, inviteUserIds);
    if (!result || !result.newlyInvited.length) return;

    const roster = rosterPayload(result.session);
    const joined = joinedMemberIds(callId);
    emitToUsers(joined, 'call:group:roster', roster);

    for (const target of result.newlyInvited) {
      emitToUser(target, 'call:group:incoming', {
        callId,
        conversationId: session.conversationId,
        callType: session.callType,
        initiatorId: session.initiatorId,
        invitedBy: userId,
        inviteUserIds: joined,
        members: roster.members,
        group: true,
      });
    }
    logger.info(`call:group:invite ${callId} +${result.newlyInvited.length} by ${userId}`);
  });

  socket.on('call:group:accept', async (payload: Record<string, unknown>) => {
    const callId = String(payload?.callId || '');
    const session = getGroupSession(callId);
    if (!session || !isSessionMember(callId, userId)) {
      socket.emit('call:error', { message: 'Call no longer available' });
      return;
    }

    const updated = acceptGroupSession(callId, userId);
    if (!updated) {
      socket.emit('call:error', { message: 'Could not join call' });
      return;
    }

    void recordCallAccepted(callId);
    const roster = rosterPayload(updated);
    const joined = joinedMemberIds(callId);

    // Notify everyone in the room (including joiner) of roster
    for (const t of joined) {
      io.to(`user:${t}`).emit('call:group:roster', { ...roster, fromUserId: userId });
    }
    // Tell existing peers that this user accepted (starts their media paths)
    for (const t of joined) {
      if (t === userId) continue;
      io.to(`user:${t}`).emit('call:group:peer-joined', {
        callId,
        userId,
        fromUserId: userId,
        members: roster.members,
      });
    }

    socket.emit('call:group:joined', {
      callId,
      conversationId: updated.conversationId,
      callType: updated.callType,
      members: roster.members,
      initiatorId: updated.initiatorId,
    });

    logger.info(`call:group:accept ${callId} by ${userId}`);
  });

  socket.on('call:group:reject', async (payload: Record<string, unknown>) => {
    const callId = String(payload?.callId || '');
    const session = rejectGroupSession(callId, userId);
    if (!session) return;

    const joined = joinedMemberIds(callId);
    const roster = rosterPayload(session);
    // Notify joined members (includes initiator if they are joined)
    emitToUsers(joined, 'call:group:peer-rejected', {
      callId,
      userId,
      members: roster.members,
    });
    // If initiator already left the joined set, still notify them once
    if (!joined.includes(session.initiatorId)) {
      emitToUser(session.initiatorId, 'call:group:peer-rejected', {
        callId,
        userId,
        members: roster.members,
      });
    }

    logger.info(`call:group:reject ${callId} by ${userId}`);
  });

  socket.on('call:group:leave', async (payload: Record<string, unknown>) => {
    const callId = String(payload?.callId || '');
    if (!callId) return;

    const { destroyed, remainingJoined, session, notifyIds } = leaveGroupSession(
      callId,
      userId
    );
    if (destroyed) {
      void recordCallEnded(callId);
      for (const m of notifyIds) {
        io.to(`user:${m}`).emit('call:group:ended', {
          callId,
          reason: 'empty',
          fromUserId: userId,
        });
      }
      logger.info(`call:group:leave ${callId} by ${userId} (room closed)`);
      return;
    }

    const roster = session ? rosterPayload(session) : null;
    emitToUsers(remainingJoined, 'call:group:peer-left', {
      callId,
      userId,
      members: roster?.members,
    });
    logger.info(`call:group:leave ${callId} by ${userId} remaining=${remainingJoined.length}`);
  });

  socket.on('call:group:end', async (payload: Record<string, unknown>) => {
    const callId = String(payload?.callId || '');
    const session = getGroupSession(callId);
    if (!session) return;
    // Only the host may end the room for everyone; others use leave
    if (session.initiatorId !== userId) return;
    const notified = endGroupSession(callId);
    void recordCallEnded(callId);
    for (const t of notified) {
      if (t === userId) continue;
      io.to(`user:${t}`).emit('call:group:ended', {
        callId,
        reason: 'ended',
        fromUserId: userId,
      });
    }
    logger.info(`call:group:end ${callId} by ${userId}`);
  });

  // ─── Media relay (1:1 + group fan-out) ────────────────────────────

  const mediaAuthCache = new Map<string, { ok: boolean; exp: number }>();
  let pcmIn = 0;
  let pcmOut = 0;
  let pcmDrop = 0;
  let lastPcmLog = 0;

  socket.on(
    'call:media',
    (payload: {
      targetUserId?: string;
      callId?: string;
      group?: boolean;
      mimeType?: string;
      format?: string;
      sampleRate?: number;
      width?: number;
      height?: number;
      data?: ArrayBuffer | Buffer | Uint8Array | number[] | string;
      dataB64?: string;
    }) => {
      void (async () => {
        if (!allowMedia(socket.id)) {
          pcmDrop += 1;
          return;
        }

        // Media frames count as presence so background calls aren't force-kicked
        touchPresence(userId);

        const callId = payload?.callId ? String(payload.callId) : '';
        const isGroup =
          !!payload?.group ||
          (!!callId && !!getGroupSession(callId) && isJoinedMember(callId, userId));

        // Normalize binary
        let data: Buffer | null = null;
        const raw = payload?.data;
        if (raw != null) {
          if (Buffer.isBuffer(raw)) {
            data = raw;
          } else if (raw instanceof ArrayBuffer) {
            data = Buffer.from(raw);
          } else if (ArrayBuffer.isView(raw)) {
            data = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
          } else if (Array.isArray(raw)) {
            data = Buffer.from(raw);
          } else if (typeof raw === 'string' && raw.length > 0) {
            try {
              data = Buffer.from(raw, 'base64');
            } catch {
              data = null;
            }
          }
        }

        const dataB64 =
          typeof payload?.dataB64 === 'string' && payload.dataB64.length > 0
            ? payload.dataB64
            : undefined;
        if (!data && dataB64) {
          try {
            data = Buffer.from(dataB64, 'base64');
          } catch {
            data = null;
          }
        }
        if (!data && !dataB64) return;

        const len = data?.length ?? (dataB64 ? Math.floor((dataB64.length * 3) / 4) : 0);
        if (len > 128 * 1024) return;

        const format = String(payload.format || '');
        const isPcm =
          format === 'pcm_s16le' ||
          (!format && !payload.mimeType?.includes('jpeg') && !payload.width);

        let outB64 = dataB64;
        if (data && !outB64) {
          // Always offer base64 — CF tunnels mangle binary JPEG as well as PCM
          outB64 = data.toString('base64');
        }

        // ── Group fan-out ──
        if (isGroup && callId) {
          if (!isJoinedMember(callId, userId)) return;
          const peers = joinedMemberIds(callId).filter((id) => id !== userId);
          if (!peers.length) return;

          const mediaBody = isPcm && outB64
            ? {
                callId,
                group: true,
                format: 'pcm_s16le' as const,
                sampleRate: payload.sampleRate || 24000,
                dataB64: outB64,
                fromUserId: userId,
              }
            : {
                callId,
                group: true,
                mimeType: payload.mimeType,
                format: payload.format,
                sampleRate: payload.sampleRate,
                width: payload.width,
                height: payload.height,
                data: data || undefined,
                dataB64: outB64,
                fromUserId: userId,
              };

          if (isPcm) pcmIn += 1;
          for (const peer of peers) {
            io.to(`user:${peer}`).emit('call:media', mediaBody);
            if (isPcm) pcmOut += 1;
          }
          return;
        }

        // ── 1:1 path ──
        const target = String(payload?.targetUserId || '');
        if (!target || target === userId) return;

        // Must be an active/ringing call pair — blocks unsolicited media spam
        if (!isActiveDirectPair(userId, target, callId || undefined)) return;

        const cacheKey = `${userId}:${target}`;
        const now = Date.now();
        let allowed = mediaAuthCache.get(cacheKey);
        if (!allowed || allowed.exp < now) {
          let ok = await usersShareDirectConversation(userId, target);
          if (ok) {
            try {
              const { isEitherBlocked } = await import(
                '../../controllers/moderation.controller'
              );
              if (await isEitherBlocked(userId, target)) ok = false;
              if (ok) {
                const { User } = await import('../../models/User');
                const peer = await User.findById(target).select('settings.privacy').lean();
                const audience = peer?.settings?.privacy?.calls || 'everyone';
                // During an active call we already gated initiate; only hard-block nobody
                // for brand-new pairs is handled by isActiveDirectPair above.
                if (audience === 'nobody' && !isActiveDirectPair(userId, target)) ok = false;
              }
            } catch {
              ok = false;
            }
          }
          allowed = { ok, exp: now + 30_000 };
          mediaAuthCache.set(cacheKey, allowed);
        }
        if (!allowed.ok) return;

        if (isPcm && outB64) {
          pcmIn += 1;
          const room = `user:${target}`;
          const roomSize = io.sockets.adapter.rooms.get(room)?.size || 0;
          io.to(room).emit('call:media', {
            callId: payload.callId,
            format: 'pcm_s16le',
            sampleRate: payload.sampleRate || 24000,
            dataB64: outB64,
            fromUserId: userId,
          });
          if (roomSize > 0) pcmOut += 1;
          else pcmDrop += 1;
          const t = Date.now();
          if (t - lastPcmLog > 5000 && process.env.NODE_ENV !== 'production') {
            lastPcmLog = t;
            // Per-socket media stats: useful locally, pure log volume in prod
            // (one line per active call every 5s).
            logger.debug(
              `call:media pcm relay ${userId.slice(-4)}→${target.slice(-4)} room=${roomSize} in=${pcmIn} out=${pcmOut} drop=${pcmDrop} b64=${outB64.length}`
            );
          }
          return;
        }

        io.to(`user:${target}`).emit('call:media', {
          callId: payload.callId,
          mimeType: payload.mimeType,
          format: payload.format,
          sampleRate: payload.sampleRate,
          width: payload.width,
          height: payload.height,
          data: data || undefined,
          dataB64: outB64,
          fromUserId: userId,
        });
      })();
    }
  );
}
