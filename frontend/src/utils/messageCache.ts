/**
 * Session message cache — instant open-chat paint without waiting on network.
 * Cleared on logout via clearSessionCaches.
 */
import type { Message } from '../types';

const PREFIX = 'pulse_msg_v1:';
const META_PREFIX = 'pulse_msg_meta_v1:';
const MAX_MESSAGES = 40;
/** Prefer network if cache older than this (still paint cache first). */
export const MSG_CACHE_FRESH_MS = 45_000;

type CachePayload = {
  messages: Message[];
  hasMore: boolean;
  at: number;
};

function key(conversationId: string, userId: string) {
  return `${PREFIX}${userId}:${conversationId}`;
}

function metaKey(conversationId: string, userId: string) {
  return `${META_PREFIX}${userId}:${conversationId}`;
}

function isUnreadable(c?: string) {
  return (
    typeof c === 'string' &&
    (c.startsWith('🔐e2e:') || c.startsWith('🔒') || /^end[- ]to[- ]end/i.test(c.trim()))
  );
}

/** Strip anything that shouldn't be persisted. */
function slimMessage(m: Message): Message {
  return {
    id: m.id,
    conversation: m.conversation,
    sender: m.sender,
    type: m.type,
    // Never persist lock placeholders as if they were real content
    content: isUnreadable(m.content) ? '' : m.content || '',
    attachments: (m.attachments || []).slice(0, 8),
    replyTo:
      m.replyTo && typeof m.replyTo === 'object'
        ? slimMessage(m.replyTo as Message)
        : m.replyTo,
    reactions: m.reactions || [],
    isEdited: m.isEdited,
    isDeleted: m.isDeleted,
    isPinned: m.isPinned,
    viewOnce: m.viewOnce,
    viewOnceOpened: m.viewOnceOpened,
    viewOnceCanOpen: m.viewOnceCanOpen,
    clientId: m.clientId,
    isE2E: m.isE2E,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    deliveredTo: m.deliveredTo,
    readBy: m.readBy,
  };
}

export function cacheMessages(
  conversationId: string,
  userId: string,
  messages: Message[],
  hasMore: boolean
): void {
  if (!conversationId || !userId || !messages?.length) return;
  // Never cache raw ciphertext or lock placeholders (would poison reload UI)
  if (messages.some((m) => isUnreadable(m.content))) return;
  try {
    const payload: CachePayload = {
      messages: messages.slice(-MAX_MESSAGES).map(slimMessage),
      hasMore,
      at: Date.now(),
    };
    sessionStorage.setItem(key(conversationId, userId), JSON.stringify(payload));
  } catch {
    /* quota */
  }
}

export function readCachedMessages(
  conversationId: string,
  userId: string
): { messages: Message[]; hasMore: boolean; at: number; fresh: boolean } | null {
  if (!conversationId || !userId) return null;
  try {
    const raw = sessionStorage.getItem(key(conversationId, userId));
    if (!raw) return null;
    const data = JSON.parse(raw) as CachePayload;
    if (!Array.isArray(data.messages) || !data.messages.length) return null;
    // Discard poisoned caches from older builds
    if (data.messages.some((m) => isUnreadable(m.content))) {
      sessionStorage.removeItem(key(conversationId, userId));
      return null;
    }
    if (data.messages.some((m) => isUnreadable(m.content))) return null;
    const at = data.at || 0;
    return {
      messages: data.messages,
      hasMore: !!data.hasMore,
      at,
      fresh: Date.now() - at < MSG_CACHE_FRESH_MS,
    };
  } catch {
    return null;
  }
}

export function clearMessageCaches(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && (k.startsWith(PREFIX) || k.startsWith(META_PREFIX))) keys.push(k);
    }
    keys.forEach((k) => sessionStorage.removeItem(k));
  } catch {
    /* */
  }
}
