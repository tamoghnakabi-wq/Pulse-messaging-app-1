/**
 * Apply E2E decryption to conversation list previews (sidebar last messages).
 */
import type { Conversation } from '../types';
import { useAuthStore } from '../store/authStore';
import { useChatStore } from '../store/chatStore';

export async function decryptAndSetConversations(
  list: Conversation[],
  opts?: { replace?: boolean; cache?: boolean }
): Promise<Conversation[]> {
  const myId = useAuthStore.getState().user?.id || '';
  let next = list;

  if (myId) {
    try {
      const { decryptConversationPreviews } = await import('../services/e2e');
      next = await decryptConversationPreviews(list, myId);
    } catch {
      next = list;
    }
  }

  if (opts?.replace !== false) {
    useChatStore.getState().setConversations(next);
  }

  if (opts?.cache) {
    try {
      const { cacheConversations } = await import('./sessionCache');
      cacheConversations(next);
    } catch {
      /* */
    }
  }

  return next;
}

/** Decrypt lastMessage on a single conversation (socket new/updated). */
export async function decryptAndUpsertConversation(conversation: Conversation): Promise<void> {
  const myId = useAuthStore.getState().user?.id || '';
  let next = conversation;
  if (myId) {
    try {
      const { decryptConversationPreviews } = await import('../services/e2e');
      const [dec] = await decryptConversationPreviews([conversation], myId);
      if (dec) next = dec;
    } catch {
      /* */
    }
  }
  useChatStore.getState().upsertConversation(next);
}
