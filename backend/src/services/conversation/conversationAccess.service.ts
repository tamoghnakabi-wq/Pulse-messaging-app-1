import { Conversation } from '../../models/Conversation';
import { AppError } from '../../utils/AppError';
import { isObjectIdString } from '../../utils/sanitize';

/**
 * Load an active conversation the user participates in.
 * Throws AppError 400/404 on invalid access (same semantics as previous controllers).
 */
export async function ensureConversationParticipant(conversationId: string, userId: string) {
  if (!isObjectIdString(conversationId)) {
    throw new AppError('Invalid conversation id', 400, 'INVALID_ID');
  }
  const conv = await Conversation.findOne({
    _id: conversationId,
    'participants.user': userId,
    isActive: true,
  });
  if (!conv) throw new AppError('Conversation not found', 404);
  return conv;
}

/**
 * Fast access check for read-only list endpoints (messages page).
 * Returns lean `{ _id }` only — do not use for mutations that need participants.
 */
export async function ensureConversationParticipantId(
  conversationId: string,
  userId: string
): Promise<{ _id: import('mongoose').Types.ObjectId }> {
  if (!isObjectIdString(conversationId)) {
    throw new AppError('Invalid conversation id', 400, 'INVALID_ID');
  }
  const conv = await Conversation.findOne({
    _id: conversationId,
    'participants.user': userId,
    isActive: true,
  })
    .select('_id')
    .lean();
  if (!conv) throw new AppError('Conversation not found', 404);
  return conv as { _id: import('mongoose').Types.ObjectId };
}

/** Whether two users share an active direct conversation (call authorization). */
export async function usersShareDirectConversation(
  userIdA: string,
  userIdB: string
): Promise<boolean> {
  if (!userIdA || !userIdB || userIdA === userIdB) return false;
  if (!isObjectIdString(userIdA) || !isObjectIdString(userIdB)) return false;
  const shared = await Conversation.exists({
    isActive: true,
    type: 'direct',
    $and: [
      { participants: { $elemMatch: { user: userIdA } } },
      { participants: { $elemMatch: { user: userIdB } } },
    ],
  });
  return !!shared;
}

/** Whether a user is an active participant of a conversation (direct or group). */
export async function userInConversation(
  conversationId: string,
  userId: string
): Promise<boolean> {
  if (!isObjectIdString(conversationId) || !isObjectIdString(userId)) return false;
  const found = await Conversation.exists({
    _id: conversationId,
    isActive: true,
    'participants.user': userId,
  });
  return !!found;
}

/**
 * User IDs that belong to the conversation (active only).
 * Used to authorize group-call invites.
 */
export async function listConversationParticipantIds(
  conversationId: string
): Promise<string[]> {
  if (!isObjectIdString(conversationId)) return [];
  const conv = await Conversation.findOne({
    _id: conversationId,
    isActive: true,
  })
    .select('participants.user')
    .lean();
  if (!conv?.participants) return [];
  return conv.participants.map((p) => String(p.user));
}
