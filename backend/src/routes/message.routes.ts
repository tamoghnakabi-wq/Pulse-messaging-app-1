import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as messageController from '../controllers/message.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  sendMessageSchema,
  editMessageSchema,
  reactMessageSchema,
  forwardMessageSchema,
} from '../validation/message.schema';
import { upload } from '../middleware/upload';

const router = Router();

// Flood protection: per-IP + per-user caps on send
const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const uid = (req as { userId?: string }).userId;
    return uid || req.ip || 'anon';
  },
  message: {
    success: false,
    error: { message: 'Sending too fast — slow down', code: 'RATE_LIMIT' },
  },
});

router.use(authenticate);

router.get('/search', messageController.searchMessages);
router.get('/pinned', messageController.getPinnedMessages);
router.get('/conversation/:conversationId', messageController.getMessages);
router.post(
  '/conversation/:conversationId',
  sendLimiter,
  upload.array('files', 10),
  validate(sendMessageSchema),
  messageController.sendMessage
);
router.patch('/:id', validate(editMessageSchema), messageController.editMessage);
router.delete('/:id/me', messageController.deleteForMe);
router.delete('/:id/everyone', messageController.deleteForEveryone);
router.post('/:id/react', validate(reactMessageSchema), messageController.reactToMessage);
router.post('/:id/forward', validate(forwardMessageSchema), messageController.forwardMessage);
router.post('/:id/pin', messageController.pinMessage);
router.post('/:id/star', messageController.starMessage);
router.post('/:id/view-once', messageController.openViewOnce);

export default router;
