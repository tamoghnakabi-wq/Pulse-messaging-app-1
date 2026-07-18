import { z } from 'zod';

const gameType = z.enum(['tic_tac_toe', 'connect_four', 'trivia_duel', 'emoji_guess']);

export const createGameSchema = z.object({
  gameType,
  options: z
    .object({
      maxPlayers: z.number().int().min(2).max(12).optional(),
      rounds: z.number().int().min(3).max(10).optional(),
      turnSeconds: z.number().int().min(8).max(300).optional(),
    })
    .optional()
    .default({}),
  inviteUserIds: z.array(z.string()).max(12).optional(),
});

export const gameActionSchema = z.object({
  action: z.record(z.unknown()).default({}),
  clientActionId: z.string().max(64).optional(),
  /** Required for optimistic concurrency */
  expectedVersion: z.number().int().positive(),
});

export const listGamesSchema = z.object({
  limit: z.coerce.number().min(1).max(50).optional().default(30),
});
