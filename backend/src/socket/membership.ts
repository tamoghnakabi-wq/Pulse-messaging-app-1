import { Conversation } from '../models/Conversation';
import { membershipCache } from '../utils/ttlCache';
import { isObjectIdString } from '../utils/sanitize';

/** Cached membership check for socket room / typing authorization. */
export async function userInConversation(
  userId: string,
  conversationId: string
): Promise<boolean> {
  if (!isObjectIdString(conversationId)) return false;
  const key = `${userId}:${conversationId}`;
  const cached = membershipCache.get(key);
  if (cached !== undefined) return cached;
  const count = await Conversation.countDocuments({
    _id: conversationId,
    'participants.user': userId,
    isActive: true,
  }).limit(1);
  const ok = count > 0;
  membershipCache.set(key, ok);
  return ok;
}
