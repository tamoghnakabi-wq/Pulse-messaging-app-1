import type { Socket } from 'socket.io';
import { Types } from 'mongoose';
import { Conversation } from '../../models/Conversation';
import { Message } from '../../models/Message';
import { isObjectIdString } from '../../utils/sanitize';
import { createSocketRateLimiter } from '../rateLimit';
import { userInConversation } from '../membership';
import { typingUsers, touchPresence } from '../presence';

interface AuthedSocket extends Socket {
  userId?: string;
}

const allowTyping = createSocketRateLimiter(8);
const allowRead = createSocketRateLimiter(15);
const allowPresence = createSocketRateLimiter(4);

/** Presence leave/ping + conversation room + typing + delivery/read receipts. */
export function registerMessagingHandlers(socket: AuthedSocket): void {
  const userId = socket.userId!;

  socket.on('presence:ping', () => {
    if (!allowPresence(socket.id)) return;
    touchPresence(userId);
  });

  socket.on('conversation:join', async (conversationId: string) => {
    touchPresence(userId);
    if (!(await userInConversation(userId, conversationId))) return;
    socket.join(`conversation:${conversationId}`);
  });

  socket.on('conversation:leave', (conversationId: string) => {
    if (!isObjectIdString(conversationId)) return;
    socket.leave(`conversation:${conversationId}`);
  });

  socket.on('typing:start', async ({ conversationId }: { conversationId: string }) => {
    if (!allowTyping(socket.id)) return;
    if (!conversationId || !(await userInConversation(userId, conversationId))) return;
    if (!typingUsers.has(conversationId)) typingUsers.set(conversationId, new Map());
    const map = typingUsers.get(conversationId)!;

    if (map.has(userId)) clearTimeout(map.get(userId)!);

    const timeout = setTimeout(() => {
      map.delete(userId);
      socket.to(`conversation:${conversationId}`).emit('typing:stop', {
        conversationId,
        userId,
      });
    }, 3000);
    map.set(userId, timeout);

    socket.to(`conversation:${conversationId}`).emit('typing:start', {
      conversationId,
      userId,
    });
  });

  socket.on('typing:stop', async ({ conversationId }: { conversationId: string }) => {
    if (!conversationId || !(await userInConversation(userId, conversationId))) return;
    const map = typingUsers.get(conversationId);
    if (map?.has(userId)) {
      clearTimeout(map.get(userId)!);
      map.delete(userId);
    }
    socket.to(`conversation:${conversationId}`).emit('typing:stop', {
      conversationId,
      userId,
    });
  });

  socket.on(
    'message:delivered',
    async ({ messageId, conversationId }: { messageId: string; conversationId: string }) => {
      try {
        if (!isObjectIdString(messageId) || !(await userInConversation(userId, conversationId))) {
          return;
        }
        await Message.updateOne(
          { _id: messageId, conversation: conversationId },
          { $addToSet: { deliveredTo: userId } }
        );
        socket.to(`conversation:${conversationId}`).emit('message:delivered', {
          messageId,
          conversationId,
          userId,
        });
      } catch {
        /* */
      }
    }
  );

  socket.on(
    'message:read',
    async ({
      conversationId,
      messageId,
    }: {
      conversationId: string;
      messageId?: string;
    }) => {
      try {
        if (!allowRead(socket.id)) return;
        if (!(await userInConversation(userId, conversationId))) return;

        // Always advance local lastRead for unread counts
        await Conversation.updateOne(
          { _id: conversationId, 'participants.user': userId },
          {
            $set: {
              'participants.$.lastReadAt': new Date(),
              ...(messageId && isObjectIdString(messageId)
                ? { 'participants.$.lastReadMessageId': new Types.ObjectId(messageId) }
                : {}),
            },
          }
        );

        // Privacy: do not write or broadcast read receipts if viewer disabled them
        const { User } = await import('../../models/User');
        const me = await User.findById(userId).select('settings.privacy.readReceipts').lean();
        const sendReceipts = me?.settings?.privacy?.readReceipts !== false;

        if (sendReceipts && messageId && isObjectIdString(messageId)) {
          await Message.updateOne(
            {
              _id: messageId,
              conversation: conversationId,
              'readBy.user': { $ne: userId },
            },
            {
              $addToSet: { deliveredTo: userId },
              $push: { readBy: { user: userId, readAt: new Date() } },
            }
          );
        }

        if (sendReceipts) {
          socket.to(`conversation:${conversationId}`).emit('messages:read', {
            conversationId,
            userId,
            messageId,
            readAt: new Date(),
          });
        }
      } catch {
        /* */
      }
    }
  );
}
