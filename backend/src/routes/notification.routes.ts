import { Router } from 'express';
import * as notificationController from '../controllers/notification.controller';
import { authenticate } from '../middleware/auth';

const router = Router();

router.use(authenticate);
router.get('/', notificationController.listNotifications);
router.post('/read-all', notificationController.markAllRead);
router.post('/:id/read', notificationController.markNotificationRead);

export default router;
