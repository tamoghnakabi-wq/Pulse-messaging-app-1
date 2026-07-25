import { create } from 'zustand';
import type { Conversation, Message, SidebarFilter } from '../types';

function sortConversations(list: Conversation[]): Conversation[] {
  return list.sort((a, b) => {
    const aPin = a.myPrefs?.isPinned ? 1 : 0;
    const bPin = b.myPrefs?.isPinned ? 1 : 0;
    if (aPin !== bPin) return bPin - aPin;
    const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return bt - at;
  });
}

/** Server payloads often re-send E2E ciphertext; never clobber decrypted UI text. */
function isLockedOrCipher(content?: string | null): boolean {
  if (!content) return false;
  return (
    content.startsWith('🔐e2e:') ||
    content.startsWith('🔒') ||
    /^end[- ]to[- ]end/i.test(content.trim())
  );
}

function preferReadable(prev?: string, next?: string): string {
  const p = prev || '';
  const n = next || '';
  if (p && !isLockedOrCipher(p) && isLockedOrCipher(n)) return p;
  if (n && !isLockedOrCipher(n)) return n;
  if (n) return n;
  return p;
}

/** Sidebar lastMessage: never replace real plaintext with a lock placeholder. */
function mergeLastMessage(
  prev: Message | undefined,
  next: Message | undefined
): Message | undefined {
  if (!next) return prev;
  if (!prev) return isLockedOrCipher(next.content) ? prev : next;
  // Same message — keep plaintext body if server/socket re-sent cipher/lock
  if (prev.id && next.id && prev.id === next.id) {
    return {
      ...prev,
      ...next,
      content: preferReadable(prev.content, next.content),
    };
  }
  // Different message: if "new" is only a lock placeholder, keep the better preview
  if (isLockedOrCipher(next.content) && !isLockedOrCipher(prev.content)) {
    return prev;
  }
  return next;
}

/** Merge a server/socket message into a local one without flashing cipher / long-loading. */
function mergeMessage(local: Message, incoming: Message): Message {
  // Skip undefined so partial patches (e.g. reactions only) don't wipe fields
  const merged: Message = { ...local };
  for (const key of Object.keys(incoming) as (keyof Message)[]) {
    const v = incoming[key];
    if (v !== undefined) {
      (merged as unknown as Record<string, unknown>)[key as string] = v;
    }
  }
  if (local.content || incoming.content) {
    merged.content = preferReadable(local.content, incoming.content);
  }
  // Keep local decrypted reply preview if the server resent ciphertext
  if (
    local.replyTo &&
    typeof local.replyTo === 'object' &&
    incoming.replyTo &&
    typeof incoming.replyTo === 'object'
  ) {
    const lr = local.replyTo as Message;
    const ir = incoming.replyTo as Message;
    merged.replyTo = {
      ...lr,
      ...ir,
      content: preferReadable(lr.content, ir.content),
    };
  }
  return merged;
}

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  typing: Record<string, string[]>;
  sidebarFilter: SidebarFilter;
  searchQuery: string;
  replyTo: Message | null;
  editingMessage: Message | null;
  uploadProgress: number | null;
  onlineUsers: Set<string>;
  focusMessageId: string | null;
  setConversations: (conversations: Conversation[]) => void;
  upsertConversation: (conversation: Conversation) => void;
  removeConversation: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
  setMessages: (conversationId: string, messages: Message[], hasMore?: boolean) => void;
  prependMessages: (conversationId: string, messages: Message[], hasMore?: boolean) => void;
  addMessage: (conversationId: string, message: Message) => void;
  updateMessage: (conversationId: string, message: Message) => void;
  removeMessage: (conversationId: string, messageId: string) => void;
  setTyping: (conversationId: string, userId: string, isTyping: boolean) => void;
  setSidebarFilter: (filter: SidebarFilter) => void;
  setSearchQuery: (q: string) => void;
  setReplyTo: (msg: Message | null) => void;
  setEditingMessage: (msg: Message | null) => void;
  setUploadProgress: (pct: number | null) => void;
  setUserOnline: (userId: string, online: boolean, lastSeen?: string | Date) => void;
  incrementUnread: (conversationId: string) => void;
  clearUnread: (conversationId: string) => void;
  /** Mark own outgoing messages as read by a peer (read receipts). */
  markMessagesReadBy: (
    conversationId: string,
    readerId: string,
    myUserId: string
  ) => void;
  setFocusMessageId: (id: string | null) => void;
  openConversationAtMessage: (conversationId: string, messageId: string) => void;
}

function readPersistedActiveConversation(): string | null {
  try {
    return sessionStorage.getItem('pulse_active_conversation');
  } catch {
    return null;
  }
}

/** Instant chat list after Safari cold-start (session cache). */
function readInitialConversations(): Conversation[] {
  try {
    // Lazy require path avoids circular imports at module eval if any
    const raw = localStorage.getItem('pulse_cached_conversations');
    if (!raw) return [];
    const list = JSON.parse(raw) as Conversation[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: readInitialConversations(),
  activeConversationId: readPersistedActiveConversation(),
  messages: {},
  hasMore: {},
  typing: {},
  sidebarFilter: 'all',
  searchQuery: '',
  replyTo: null,
  editingMessage: null,
  uploadProgress: null,
  onlineUsers: new Set(),
  focusMessageId: null,

  setConversations: (conversations) => set({ conversations }),

  upsertConversation: (conversation) =>
    set((state) => {
      const idx = state.conversations.findIndex((c) => c.id === conversation.id);
      let list: Conversation[];
      if (idx >= 0) {
        // Skip no-op merges
        const prev = state.conversations[idx];
        if (prev === conversation) return state;
        list = [...state.conversations];
        // Skip undefined fields so partial E2E/key updates never wipe lastMessage
        const patch: Partial<Conversation> = {};
        for (const key of Object.keys(conversation) as (keyof Conversation)[]) {
          const v = conversation[key];
          if (v !== undefined) {
            (patch as Record<string, unknown>)[key as string] = v;
          }
        }
        const merged: Conversation = { ...prev, ...patch };
        // Protect sidebar preview from cipher / "Encrypted message" clobber
        if ('lastMessage' in patch) {
          merged.lastMessage = mergeLastMessage(
            prev.lastMessage as Message | undefined,
            patch.lastMessage as Message | undefined
          ) as Conversation['lastMessage'];
          // If we kept prev lastMessage, also keep its timestamp when next was locked
          if (
            merged.lastMessage === prev.lastMessage &&
            prev.lastMessageAt &&
            patch.lastMessage &&
            isLockedOrCipher((patch.lastMessage as Message).content)
          ) {
            merged.lastMessageAt = prev.lastMessageAt;
          }
        }
        list[idx] = merged;
      } else {
        list = [conversation, ...state.conversations];
      }
      return { conversations: sortConversations(list) };
    }),

  removeConversation: (id) =>
    set((state) => {
      const { [id]: _m, ...messages } = state.messages;
      const { [id]: _h, ...hasMore } = state.hasMore;
      const { [id]: _t, ...typing } = state.typing;
      return {
        conversations: state.conversations.filter((c) => c.id !== id),
        messages,
        hasMore,
        typing,
        activeConversationId:
          state.activeConversationId === id ? null : state.activeConversationId,
      };
    }),

  setActiveConversation: (id) => {
    if (get().activeConversationId === id && id !== null) {
      // Still clear reply/edit when re-tapping same chat
      set({ replyTo: null, editingMessage: null, focusMessageId: null });
      return;
    }
    set({ activeConversationId: id, replyTo: null, editingMessage: null, focusMessageId: null });
    // Persist so iOS Safari cold-start after background restores the open chat
    try {
      if (id) sessionStorage.setItem('pulse_active_conversation', id);
      else sessionStorage.removeItem('pulse_active_conversation');
    } catch {
      /* */
    }
    // Instant hydrate + start network load as soon as the chat is selected
    // (runs before ChatWindow effects — shaves a paint off open)
    if (id) {
      void import('../utils/loadConversationMessages').then(
        ({ hydrateMessagesFromSessionCache, prefetchConversationMessages }) => {
          hydrateMessagesFromSessionCache(id);
          void prefetchConversationMessages(id, { limit: 20 });
        }
      );
    }
  },

  setFocusMessageId: (id) => set({ focusMessageId: id }),

  openConversationAtMessage: (conversationId, messageId) =>
    set({
      activeConversationId: conversationId,
      focusMessageId: messageId,
      replyTo: null,
      editingMessage: null,
    }),

  setMessages: (conversationId, messages, hasMore = false) =>
    set((state) => ({
      messages: { ...state.messages, [conversationId]: messages },
      hasMore: { ...state.hasMore, [conversationId]: hasMore },
    })),

  prependMessages: (conversationId, messages, hasMore = false) =>
    set((state) => {
      const existing = state.messages[conversationId] || [];
      if (!messages.length) {
        return { hasMore: { ...state.hasMore, [conversationId]: hasMore } };
      }
      const ids = new Set(existing.map((m) => m.id));
      const unique = messages.filter((m) => !ids.has(m.id));
      if (!unique.length) {
        return { hasMore: { ...state.hasMore, [conversationId]: hasMore } };
      }
      return {
        messages: { ...state.messages, [conversationId]: [...unique, ...existing] },
        hasMore: { ...state.hasMore, [conversationId]: hasMore },
      };
    }),

  addMessage: (conversationId, message) =>
    set((state) => {
      const existing = state.messages[conversationId] || [];
      // Newest messages are at the end — scan reverse for optimistic / echo dupes
      let dupeIdx = -1;
      for (let i = existing.length - 1; i >= 0; i--) {
        const m = existing[i];
        // Optimistic rows are created with id === clientId (see MessageInput),
        // so a server echo matches on either key. The three trailing clauses
        // this replaces were all the same `m.clientId === message.clientId`
        // comparison written three ways.
        if (
          m.id === message.id ||
          (message.clientId && m.clientId === message.clientId) ||
          (message.clientId && m.id === message.clientId)
        ) {
          dupeIdx = i;
          break;
        }
        // Only search the recent tail (optimistic sends land near end)
        if (existing.length - i > 40) break;
      }

      let nextMessages: Message[];
      if (dupeIdx >= 0) {
        nextMessages = existing.slice();
        const prev = existing[dupeIdx];
        // Never replace readable plaintext with ciphertext / lock placeholder
        // (socket echo can race with local optimistic decrypt).
        const prevContent = prev.content || '';
        const nextContent = message.content || '';
        const prevReadable =
          prevContent &&
          !prevContent.startsWith('🔐e2e:') &&
          !prevContent.startsWith('🔒');
        const nextLocked =
          !nextContent ||
          nextContent.startsWith('🔐e2e:') ||
          nextContent.startsWith('🔒');
        nextMessages[dupeIdx] = {
          ...prev,
          ...message,
          clientId: message.clientId || prev.clientId,
          content: prevReadable && nextLocked ? prevContent : nextContent || prevContent,
        };
      } else {
        nextMessages = existing.length ? [...existing, message] : [message];
      }

      // Keep only a sliding window in RAM (older pages re-fetched via before cursor)
      const capped =
        nextMessages.length > 250 ? nextMessages.slice(nextMessages.length - 250) : nextMessages;

      // Patch only the matching conversation row (avoid remapping every chat)
      // Prefer readable plaintext for sidebar preview (never show ciphertext if we have plain)
      const previewMessage = (() => {
        const content = message.content || '';
        const locked =
          content.startsWith('🔐e2e:') || content.startsWith('🔒 Encrypted');
        if (!locked) return message;
        // If merge replaced a plain optimistic body, keep plain for the list row
        const prevMsg =
          dupeIdx >= 0 ? existing[dupeIdx] : undefined;
        if (
          prevMsg?.content &&
          !prevMsg.content.startsWith('🔐e2e:') &&
          !prevMsg.content.startsWith('🔒')
        ) {
          return { ...message, content: prevMsg.content };
        }
        return message;
      })();

      const idx = state.conversations.findIndex((c) => c.id === conversationId);
      let conversations = state.conversations;
      if (idx >= 0) {
        const prev = state.conversations[idx];
        conversations = state.conversations.slice();
        conversations[idx] = {
          ...prev,
          lastMessage: previewMessage,
          lastMessageAt: message.createdAt,
        };
        // Re-sort only when this row is not already at the top of its pin group
        if (idx !== 0 || prev.myPrefs?.isPinned) {
          conversations = sortConversations(conversations);
        }
      }

      return {
        messages: {
          ...state.messages,
          [conversationId]: capped,
        },
        conversations,
      };
    }),

  updateMessage: (conversationId, message) =>
    set((state) => {
      const list = state.messages[conversationId];
      if (!list) return state;
      let changed = false;
      const next = list.map((m) => {
        if (m.id !== message.id && !(message.clientId && m.clientId === message.clientId)) {
          return m;
        }
        changed = true;
        return mergeMessage(m, message);
      });
      if (!changed) return state;
      return {
        messages: { ...state.messages, [conversationId]: next },
      };
    }),

  removeMessage: (conversationId, messageId) =>
    set((state) => {
      const list = state.messages[conversationId];
      if (!list) return state;
      return {
        messages: {
          ...state.messages,
          [conversationId]: list.filter((m) => m.id !== messageId),
        },
      };
    }),

  setTyping: (conversationId, userId, isTyping) =>
    set((state) => {
      const current = state.typing[conversationId] || [];
      const has = current.includes(userId);
      if (isTyping && has) return state;
      if (!isTyping && !has) return state;
      const next = isTyping
        ? [...current, userId]
        : current.filter((id) => id !== userId);
      return {
        typing: {
          ...state.typing,
          [conversationId]: next,
        },
      };
    }),

  setSidebarFilter: (filter) => {
    if (get().sidebarFilter === filter) return;
    set({ sidebarFilter: filter });
  },
  setSearchQuery: (q) => set({ searchQuery: q }),
  setReplyTo: (msg) => set({ replyTo: msg, editingMessage: null }),
  setEditingMessage: (msg) => set({ editingMessage: msg, replyTo: null }),
  setUploadProgress: (pct) => set({ uploadProgress: pct }),

  setUserOnline: (userId, online, lastSeen) =>
    set((state) => {
      const wasOnline = state.onlineUsers.has(userId);
      if (wasOnline === online && online) {
        // Already online — skip full conversation map
        return state;
      }
      const next = new Set(state.onlineUsers);
      if (online) next.add(userId);
      else next.delete(userId);
      const seen =
        lastSeen instanceof Date
          ? lastSeen.toISOString()
          : lastSeen || (!online ? new Date().toISOString() : undefined);

      // Patch only direct chats that include this user (index walk, not remap-all semantics)
      let any = false;
      let conversations = state.conversations;
      for (let i = 0; i < state.conversations.length; i++) {
        const c = state.conversations[i];
        if (c.type !== 'direct') continue;
        const other = c.participants.find((p) => p.user.id === userId);
        if (!other) continue;
        if (c.isOnline === online && (!seen || c.lastSeen === seen)) continue;
        if (!any) {
          conversations = state.conversations.slice();
          any = true;
        }
        conversations[i] = {
          ...c,
          isOnline: online,
          lastSeen: seen || c.lastSeen,
          participants: c.participants.map((p) =>
            p.user.id === userId
              ? {
                  ...p,
                  user: {
                    ...p.user,
                    isOnline: online,
                    lastSeen: seen || p.user.lastSeen,
                  },
                }
              : p
          ),
        };
      }
      if (!any && wasOnline === online) return state;
      return { onlineUsers: next, conversations };
    }),

  incrementUnread: (conversationId) =>
    set((state) => {
      const idx = state.conversations.findIndex((c) => c.id === conversationId);
      if (idx < 0) return state;
      const c = state.conversations[idx];
      const list = state.conversations.slice();
      list[idx] = { ...c, unreadCount: (c.unreadCount || 0) + 1 };
      return { conversations: list };
    }),

  clearUnread: (conversationId) =>
    set((state) => {
      const idx = state.conversations.findIndex((c) => c.id === conversationId);
      if (idx < 0) return state;
      const c = state.conversations[idx];
      if (!c.unreadCount) return state;
      const list = state.conversations.slice();
      list[idx] = { ...c, unreadCount: 0 };
      return { conversations: list };
    }),

  /** Patch read receipts without rewriting the entire message array when nothing changes. */
  markMessagesReadBy: (conversationId, readerId, myUserId) =>
    set((state) => {
      const list = state.messages[conversationId];
      if (!list || readerId === myUserId) return state;
      let changed = false;
      const next = list.map((m) => {
        const sid =
          typeof m.sender === 'string'
            ? m.sender
            : (m.sender as { id?: string; _id?: string })?.id ||
              (m.sender as { _id?: string })?._id ||
              '';
        if (sid !== myUserId) return m;
        const readBy = m.readBy || [];
        if (readBy.some((r) => r.user === readerId)) return m;
        changed = true;
        return {
          ...m,
          readBy: [...readBy, { user: readerId, readAt: new Date().toISOString() }],
          deliveredTo: Array.from(new Set([...(m.deliveredTo || []), readerId])),
        };
      });
      if (!changed) return state;
      return {
        messages: { ...state.messages, [conversationId]: next },
      };
    }),
}));
