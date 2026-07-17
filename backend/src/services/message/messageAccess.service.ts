import { Message } from '../../models/Message';
import { AppError } from '../../utils/AppError';
import { isObjectIdString } from '../../utils/sanitize';
import {
  ensureConversationParticipant,
  ensureConversationParticipantId,
} from '../conversation/conversationAccess.service';

/** Lean populate graph for message list (keeps first page fast on mobile/tunnel). */
export const messagePopulatePaths = [
  { path: 'sender', select: 'username displayName avatar' },
  {
    path: 'replyTo',
    // Only fields needed for reply previews — skip nested reaction/read arrays
    select: 'content type sender isDeleted isE2E createdAt',
    populate: { path: 'sender', select: 'username displayName avatar' },
  },
  { path: 'forwardedFrom', select: 'content type sender' },
  { path: 'mentions', select: 'username displayName' },
];

/**
 * Load a message and verify the user may access its conversation.
 */
export async function ensureMessageAccess(messageId: string, userId: string) {
  if (!isObjectIdString(messageId)) {
    throw new AppError('Invalid message id', 400, 'INVALID_ID');
  }
  const message = await Message.findById(messageId);
  if (!message) throw new AppError('Message not found', 404);
  await ensureConversationParticipant(message.conversation.toString(), userId);
  return message;
}

export { ensureConversationParticipant, ensureConversationParticipantId };
