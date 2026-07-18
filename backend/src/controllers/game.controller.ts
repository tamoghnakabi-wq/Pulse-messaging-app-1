import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import asyncHandler from '../utils/asyncHandler';
import { gameService } from '../services/game/game.service';
import {
  getConversationLeaderboard,
  getUserStats,
} from '../services/game/gameStats.service';
import { AppError } from '../utils/AppError';

export const catalog = asyncHandler(async (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: { games: gameService.catalog() } });
});

export const createGame = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { gameType, options, inviteUserIds } = req.body;
  const dto = await gameService.createInvitation(
    req.userId!,
    req.params.conversationId,
    gameType,
    options || {},
    inviteUserIds
  );
  res.status(201).json({ success: true, data: { game: dto } });
});

export const getGame = asyncHandler(async (req: AuthRequest, res: Response) => {
  const game = await gameService.getGame(req.userId!, req.params.id);
  res.json({ success: true, data: { game } });
});

export const listGames = asyncHandler(async (req: AuthRequest, res: Response) => {
  const limit = Number(req.query.limit) || 30;
  const games = await gameService.listConversationGames(
    req.userId!,
    req.params.conversationId,
    limit
  );
  res.json({ success: true, data: { games } });
});

export const joinGame = asyncHandler(async (req: AuthRequest, res: Response) => {
  const game = await gameService.join(req.userId!, req.params.id);
  res.json({ success: true, data: { game } });
});

export const declineGame = asyncHandler(async (req: AuthRequest, res: Response) => {
  const game = await gameService.decline(req.userId!, req.params.id);
  res.json({ success: true, data: { game } });
});

export const cancelGame = asyncHandler(async (req: AuthRequest, res: Response) => {
  const game = await gameService.cancel(req.userId!, req.params.id);
  res.json({ success: true, data: { game } });
});

export const startGame = asyncHandler(async (req: AuthRequest, res: Response) => {
  const game = await gameService.start(req.userId!, req.params.id);
  res.json({ success: true, data: { game } });
});

export const gameAction = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { action, clientActionId, expectedVersion } = req.body;
  const game = await gameService.action(
    req.userId!,
    req.params.id,
    action || {},
    clientActionId,
    expectedVersion
  );
  res.json({ success: true, data: { game } });
});

export const rematch = asyncHandler(async (req: AuthRequest, res: Response) => {
  const game = await gameService.rematch(req.userId!, req.params.id);
  res.status(201).json({ success: true, data: { game } });
});

export const leaderboard = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { ensureConversationParticipant } = await import(
    '../services/conversation/conversationAccess.service'
  );
  await ensureConversationParticipant(req.params.conversationId, req.userId!);
  const board = await getConversationLeaderboard(req.params.conversationId);
  res.json({ success: true, data: { leaderboard: board } });
});

export const myStats = asyncHandler(async (req: AuthRequest, res: Response) => {
  const conversationId =
    typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined;
  if (conversationId) {
    const { ensureConversationParticipant } = await import(
      '../services/conversation/conversationAccess.service'
    );
    await ensureConversationParticipant(conversationId, req.userId!);
  }
  const stats = await getUserStats(req.userId!, conversationId);
  res.json({ success: true, data: { stats } });
});

export const expireStale = asyncHandler(async (req: AuthRequest, res: Response) => {
  // Not a public user-facing trigger: require CRON_SECRET always (scheduler is in-process).
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers['x-pulse-cron'] !== secret) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
  const n = await gameService.expireStale();
  res.json({ success: true, data: { expired: n } });
});
