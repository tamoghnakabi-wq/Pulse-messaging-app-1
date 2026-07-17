import { Router } from 'express';
import * as userController from '../controllers/user.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { updateProfileSchema, updateSettingsSchema } from '../validation/user.schema';
import { changePasswordSchema } from '../validation/auth.schema';
import { upload } from '../middleware/upload';

const router = Router();

router.use(authenticate);

router.get('/search', userController.searchUsers);
router.get('/starred', userController.getStarredMessages);
router.put('/me/keys', userController.upsertIdentityKey);
router.put('/me/e2e-backup', userController.putE2EKeyBackup);
router.get('/me/e2e-backup', userController.getE2EKeyBackup);
router.get('/:id/keys', userController.getIdentityKey);
router.get('/:id', userController.getUser);
router.patch('/me', validate(updateProfileSchema), userController.updateProfile);
router.patch('/me/settings', validate(updateSettingsSchema), userController.updateSettings);
router.post('/me/avatar', upload.single('avatar'), userController.uploadAvatar);
router.post('/me/cover', upload.single('cover'), userController.uploadCoverPhoto);
router.delete('/me/cover', userController.removeCoverPhoto);
router.post('/me/password', validate(changePasswordSchema), userController.changePassword);

// Block / report (abuse prevention)
import * as moderation from '../controllers/moderation.controller';
router.get('/me/blocked', moderation.listBlocked);
router.post('/me/blocked/:userId', moderation.blockUser);
router.delete('/me/blocked/:userId', moderation.unblockUser);
router.post('/report', moderation.reportUser);

export default router;
