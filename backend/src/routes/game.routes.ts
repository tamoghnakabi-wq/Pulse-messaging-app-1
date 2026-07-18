import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  createGameSchema,
  gameActionSchema,
  listGamesSchema,
} from '../validation/game.schema';
import * as gameController from '../controllers/game.controller';

const router = Router();

const gameCreateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as { userId?: string }).userId || req.ip || 'anon',
  message: {
    success: false,
    error: { message: 'Creating games too fast', code: 'RATE_LIMIT' },
  },
});

const gameActionLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as { userId?: string }).userId || req.ip || 'anon',
  message: {
    success: false,
    error: { message: 'Too many game actions', code: 'RATE_LIMIT' },
  },
});

router.use(authenticate);

router.get('/catalog', gameController.catalog);
router.get('/stats/me', gameController.myStats);
router.get(
  '/conversation/:conversationId',
  validate(listGamesSchema, 'query'),
  gameController.listGames
);
router.get(
  '/conversation/:conversationId/leaderboard',
  gameController.leaderboard
);
router.post(
  '/conversation/:conversationId',
  gameCreateLimiter,
  validate(createGameSchema),
  gameController.createGame
);
router.get('/:id', gameController.getGame);
router.post('/:id/join', gameActionLimiter, gameController.joinGame);
router.post('/:id/decline', gameActionLimiter, gameController.declineGame);
router.post('/:id/cancel', gameActionLimiter, gameController.cancelGame);
router.post('/:id/start', gameActionLimiter, gameController.startGame);
router.post(
  '/:id/action',
  gameActionLimiter,
  validate(gameActionSchema),
  gameController.gameAction
);
router.post('/:id/rematch', gameCreateLimiter, gameController.rematch);
router.post('/internal/expire', gameController.expireStale);

export default router;
