import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { getCallHistory } from '../controllers/call.controller';

const router = Router();

router.use(authenticate);
router.get('/history', getCallHistory);

export default router;
