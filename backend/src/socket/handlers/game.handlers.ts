import { Server, Socket } from 'socket.io';
import { gameService } from '../../services/game/game.service';
import { createSocketRateLimiter } from '../rateLimit';
import logger from '../../utils/logger';

interface AuthedSocket extends Socket {
  userId?: string;
}

const actionLimiter = createSocketRateLimiter(15);

/**
 * Optional socket shortcuts — REST is primary.
 * Broadcasts still go through gameService → conversation room.
 */
export function registerGameHandlers(_io: Server, socket: AuthedSocket): void {
  const userId = socket.userId;
  if (!userId) return;

  socket.on(
    'game:action',
    async (payload: {
      gameId?: string;
      action?: Record<string, unknown>;
      clientActionId?: string;
      expectedVersion?: number;
    }) => {
      if (!actionLimiter(socket.id)) {
        socket.emit('game:error', { code: 'RATE_LIMIT', message: 'Too many actions' });
        return;
      }
      try {
        const gameId = String(payload?.gameId || '');
        if (!gameId) {
          socket.emit('game:error', { code: 'VALIDATION', message: 'gameId required' });
          return;
        }
        if (
          payload?.expectedVersion == null ||
          !Number.isInteger(Number(payload.expectedVersion))
        ) {
          socket.emit('game:error', {
            code: 'VERSION_REQUIRED',
            message: 'expectedVersion is required',
          });
          return;
        }
        const game = await gameService.action(
          userId,
          gameId,
          payload?.action || {},
          payload?.clientActionId,
          Number(payload.expectedVersion)
        );
        socket.emit('game:action:ok', { game });
      } catch (e) {
        const err = e as { message?: string; code?: string; statusCode?: number };
        socket.emit('game:error', {
          code: err.code || 'GAME_ERROR',
          message: err.message || 'Action failed',
        });
        logger.debug(`game:action error ${userId}: ${err.message}`);
      }
    }
  );

  socket.on('game:join', async (payload: { gameId?: string }) => {
    if (!actionLimiter(socket.id)) return;
    try {
      const game = await gameService.join(userId, String(payload?.gameId || ''));
      socket.emit('game:action:ok', { game });
    } catch (e) {
      const err = e as { message?: string; code?: string };
      socket.emit('game:error', {
        code: err.code || 'GAME_ERROR',
        message: err.message || 'Join failed',
      });
    }
  });

  // Clients no longer trigger global expiry sweeps (server scheduler is authoritative).
  socket.on('game:expire-check', () => {
    /* intentional no-op */
  });
}
