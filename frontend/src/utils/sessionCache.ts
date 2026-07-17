/**
 * Lightweight client cache for instant shell paint on reload.
 * Always revalidated against the network after hydrate.
 */
import type { Conversation, User } from '../types';

const USER_KEY = 'pulse_cached_user';
const CONV_KEY = 'pulse_cached_conversations';
const CONV_TS_KEY = 'pulse_cached_conversations_ts';
/** Conversations older than this are still shown, then refreshed. */
const CONV_MAX_AGE_MS = 30 * 60 * 1000;

export function cacheUser(user: User | null): void {
  try {
    if (!user) {
      localStorage.removeItem(USER_KEY);
      return;
    }
    // Don't persist huge settings blobs beyond what's needed for shell
    const slim: User = {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      bio: user.bio,
      avatar: user.avatar,
      coverPhoto: user.coverPhoto,
      isOnline: user.isOnline,
      lastSeen: user.lastSeen,
      isEmailVerified: user.isEmailVerified,
      settings: user.settings,
      createdAt: user.createdAt,
    };
    localStorage.setItem(USER_KEY, JSON.stringify(slim));
  } catch {
    /* quota / private mode */
  }
}

export function readCachedUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw) as User;
    if (!u?.id || !u.username) return null;
    return u;
  } catch {
    return null;
  }
}

export function cacheConversations(list: Conversation[]): void {
  try {
    // Cap payload — keep e2e wraps so open-chat can decrypt without an extra GET
    const slim = list.slice(0, 80).map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      displayName: c.displayName,
      avatar: c.avatar,
      lastMessage: c.lastMessage
        ? {
            id: (c.lastMessage as { id?: string }).id,
            content: (c.lastMessage as { content?: string }).content,
            type: (c.lastMessage as { type?: string }).type,
            createdAt: (c.lastMessage as { createdAt?: string }).createdAt,
            isDeleted: (c.lastMessage as { isDeleted?: boolean }).isDeleted,
            sender: (c.lastMessage as { sender?: unknown }).sender,
            isE2E: (c.lastMessage as { isE2E?: boolean }).isE2E,
          }
        : undefined,
      lastMessageAt: c.lastMessageAt,
      unreadCount: c.unreadCount,
      isOnline: c.isOnline,
      lastSeen: c.lastSeen,
      participants: c.participants,
      myPrefs: c.myPrefs,
      hasPinnedMessages: c.hasPinnedMessages,
      hasStarredMessages: c.hasStarredMessages,
      e2eVersion: c.e2eVersion,
      // Critical for instant decrypt without getConversation on open
      e2eWrappedKeys: c.e2eWrappedKeys,
    }));
    localStorage.setItem(CONV_KEY, JSON.stringify(slim));
    localStorage.setItem(CONV_TS_KEY, String(Date.now()));
  } catch {
    /* */
  }
}

export function readCachedConversations(): Conversation[] | null {
  try {
    const ts = Number(localStorage.getItem(CONV_TS_KEY) || 0);
    if (ts && Date.now() - ts > CONV_MAX_AGE_MS * 6) {
      // Very stale — discard
      localStorage.removeItem(CONV_KEY);
      localStorage.removeItem(CONV_TS_KEY);
      return null;
    }
    const raw = localStorage.getItem(CONV_KEY);
    if (!raw) return null;
    const list = JSON.parse(raw) as Conversation[];
    if (!Array.isArray(list) || !list.length) return null;
    return list;
  } catch {
    return null;
  }
}

export function clearSessionCaches(): void {
  try {
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(CONV_KEY);
    localStorage.removeItem(CONV_TS_KEY);
  } catch {
    /* */
  }
  try {
    void import('./messageCache').then((m) => m.clearMessageCaches());
  } catch {
    /* */
  }
}

/** Kick off ChatPage chunk download as early as possible. */
export function prefetchChatShell(): void {
  void import('../pages/ChatPage');
}

/** Prefetch conversation list into the chat store (and disk cache). */
export async function prefetchConversations(): Promise<void> {
  try {
    const { chatService } = await import('../services/chat.service');
    const list = await chatService.getConversations('all');
    const { decryptAndSetConversations } = await import('./decryptConversationList');
    await decryptAndSetConversations(list || [], { cache: true });
  } catch {
    /* non-fatal — Sidebar will retry */
  }
}
