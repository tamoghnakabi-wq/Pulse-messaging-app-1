import { Router } from 'express';
import * as conversationController from '../controllers/conversation.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  createDirectSchema,
  createGroupSchema,
  updateGroupSchema,
  addParticipantsSchema,
  updateParticipantRoleSchema,
  conversationPrefsSchema,
} from '../validation/conversation.schema';
import { upload } from '../middleware/upload';

const router = Router();

router.use(authenticate);

router.get('/', conversationController.listConversations);
router.get('/:id', conversationController.getConversation);
router.post('/direct', validate(createDirectSchema), conversationController.createDirect);
router.post('/group', validate(createGroupSchema), conversationController.createGroup);
router.patch('/:id', validate(updateGroupSchema), conversationController.updateGroup);
router.post('/:id/avatar', upload.single('avatar'), conversationController.uploadGroupAvatar);
router.post(
  '/:id/participants',
  validate(addParticipantsSchema),
  conversationController.addParticipants
);
router.delete('/:id/participants/:userId', conversationController.removeParticipant);
router.patch(
  '/:id/participants/:userId/role',
  validate(updateParticipantRoleSchema),
  conversationController.updateParticipantRole
);
// Delete chat for current user only (direct or group) — must be before `/:id`
router.delete('/:id/me', conversationController.deleteConversationForMe);
// Owner disbands group for everyone
router.delete('/:id', conversationController.deleteGroup);
router.patch(
  '/:id/prefs',
  validate(conversationPrefsSchema),
  conversationController.updatePrefs
);
router.post('/:id/read', conversationController.markRead);
router.put('/:id/e2e-keys', conversationController.setE2EKeys);

export default router;
