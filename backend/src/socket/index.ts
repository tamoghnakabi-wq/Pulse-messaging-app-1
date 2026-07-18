import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { verifyAccessToken } from '../utils/tokens';
import { User } from '../models/User';
import { Session } from '../models/Session';
import { Conversation } from '../models/Conversation';
import config from '../config';
import logger from '../utils/logger';
import { registerCallHandlers } from './handlers/call.handlers';
import { registerMessagingHandlers } from './handlers/messaging.handlers';
import { registerGameHandlers } from './handlers/game.handlers';
import {
  onlineUsers,
  typingUsers,
  cancelScheduledOffline,
  touchPresence,
  scheduleOffline,
  emitPresenceToContacts,
  startPresenceSweeper,
} from './presence';
import {
  getActiveCallForUser,
  leaveGroupSession,
  rosterPayload,
} from '../services/call/groupCall.registry';
import { recordCallEnded } from '../services/call/callLog.service';

export {
  isUserOnline,
  getOnlineUserIds,
  resetPresenceOnBoot,
} from './presence';

let io: Server | null = null;

export function getIO(): Server {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

interface AuthedSocket extends Socket {
  userId?: string;
  sessionId?: string;
}

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }
        if (config.env === 'development') {
          callback(null, true);
          return;
        }
        if (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    allowEIO3: false,
    // Cloudflare free tunnels add latency — avoid premature disconnects mid-call
    pingTimeout: 45000,
    pingInterval: 20000,
    // Batched base64 PCM + JPEG frames through CF can exceed 256KB bursts
    maxHttpBufferSize: 1 * 1024 * 1024,
    path: '/socket.io',
    // Compression fights binary/base64 media and adds CPU on the hot path
    perMessageDeflate: false,
    httpCompression: false,
  });

  io.use(async (socket: AuthedSocket, next) => {
    try {
      const token =
        (socket.handshake.auth?.token as string) ||
        (socket.handshake.headers.authorization as string)?.replace(/^Bearer\s+/i, '');

      if (!token) return next(new Error('Authentication required'));
      if (token.length > 4096 || token.split('.').length !== 3) {
        return next(new Error('Invalid token'));
      }

      const payload = verifyAccessToken(token);
      const session = await Session.findOne({
        _id: payload.sessionId,
        user: payload.userId,
        isValid: true,
        expiresAt: { $gt: new Date() },
      })
        .select('_id')
        .lean();

      if (!session) return next(new Error('Invalid session'));

      socket.userId = payload.userId;
      socket.sessionId = payload.sessionId;
      // Also store on data for fetchSockets disconnect matching
      socket.data.sessionId = payload.sessionId;
      socket.data.userId = payload.userId;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  startPresenceSweeper(io);

  io.on('connection', async (socket: AuthedSocket) => {
    const userId = socket.userId!;
    logger.info(`Socket connected: ${userId} (${socket.id})`);

    cancelScheduledOffline(userId);
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId)!.add(socket.id);
    touchPresence(userId);

    socket.join(`user:${userId}`);

    const convs = await Conversation.find({
      'participants.user': userId,
      isActive: true,
    })
      .select('_id')
      .lean();
    convs.forEach((c) => socket.join(`conversation:${c._id}`));

    if (onlineUsers.get(userId)!.size === 1) {
      await User.findByIdAndUpdate(userId, { isOnline: true, lastSeen: new Date() });
      void emitPresenceToContacts(io, userId, 'user:online', {
        userId,
        isOnline: true,
        lastSeen: new Date(),
      });
    }

    // Soft leave when tab hides/unloads — do NOT force-disconnect
    socket.on('presence:leave', () => {
      touchPresence(userId);
      const set = onlineUsers.get(userId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          onlineUsers.delete(userId);
          scheduleOffline(io, userId);
        }
      }
    });

    registerMessagingHandlers(socket);
    registerCallHandlers(io!, socket);
    registerGameHandlers(io!, socket);

    socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${userId} (${socket.id}) reason=${reason}`);
      const set = onlineUsers.get(userId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          onlineUsers.delete(userId);
          scheduleOffline(io, userId);

          // Leave any group call so peers don't keep a ghost participant
          const activeCallId = getActiveCallForUser(userId);
          if (activeCallId && io) {
            const { destroyed, remainingJoined, notifyIds, session } = leaveGroupSession(
              activeCallId,
              userId
            );
            if (destroyed) {
              void recordCallEnded(activeCallId);
              for (const m of notifyIds) {
                io.to(`user:${m}`).emit('call:group:ended', {
                  callId: activeCallId,
                  reason: 'disconnect',
                  fromUserId: userId,
                });
              }
            } else if (session) {
              const roster = rosterPayload(session);
              for (const t of remainingJoined) {
                io.to(`user:${t}`).emit('call:group:peer-left', {
                  callId: activeCallId,
                  userId,
                  members: roster.members,
                  fromUserId: userId,
                });
              }
            }
            logger.info(`Group call leave on disconnect: ${userId} call=${activeCallId}`);
          }
        }
      }

      typingUsers.forEach((map, convId) => {
        if (map.has(userId)) {
          clearTimeout(map.get(userId)!);
          map.delete(userId);
          socket.to(`conversation:${convId}`).emit('typing:stop', {
            conversationId: convId,
            userId,
          });
        }
      });
    });
  });

  return io;
}

export default initSocket;
