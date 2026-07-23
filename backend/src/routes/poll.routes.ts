import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { createPollSchema, votePollSchema } from '../validation/poll.schema';
import * as pollController from '../controllers/poll.controller';

const router = Router();

const pollCreateLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: 'Too many polls', code: 'RATE_LIMIT' } },
});

const pollVoteLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: 'Too many votes', code: 'RATE_LIMIT' } },
});

router.use(authenticate);

router.post('/', pollCreateLimiter, validate(createPollSchema), pollController.createPoll);
router.get('/:id', pollController.getPoll);
router.post('/:id/vote', pollVoteLimiter, validate(votePollSchema), pollController.votePoll);
router.post('/:id/close', pollController.closePoll);

export default router;
