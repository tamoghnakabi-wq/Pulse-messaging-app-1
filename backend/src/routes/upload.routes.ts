import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as uploadController from '../controllers/upload.controller';
import { authenticate } from '../middleware/auth';
import { upload } from '../middleware/upload';

const router = Router();

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { message: 'Too many uploads', code: 'RATE_LIMIT' },
  },
});

router.use(authenticate);
router.post('/', uploadLimiter, upload.array('files', 10), uploadController.uploadFiles);

export default router;
