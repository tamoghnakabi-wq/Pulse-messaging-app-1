/**
 * Fast path for loading + decrypting a conversation page.
 * Shared by ChatWindow open and Sidebar prefetch — single-flight per chat.
 */
import { chatService } from '../services/chat.service';
import { useAuthStore } from '../store/authStore';
import { useChatStore } from '../store/chatStore';
import { cacheMessages, readCachedMessages } from './messageCache';
import type { Message } from '../types';

export type LoadedMessages = {
  messages: Message[];
  hasMore: boolean;
  fromCache?: boolean;
};

/** All in-flight loads (open + prefetch share the same promise). */
const loadInFlight = new Map<string, Promise<LoadedMessages>>();

function flightKey(conversationId: string, before?: string) {
  return before ? `${conversationId}:before:${before}` : conversationId;
}

function stripCipherEnvelopes(messages: Message[]): Message[] {
  return messages.map((m) =>
    typeof m.content === 'string' && m.content.startsWith('🔐e2e:')
      ? { ...m, content: '🔒 Encrypted message' }
      : m
  );
}

/**
 * Hydrate the store from session cache (sync). Returns true if painted.
 * Call before network so open-chat is instant on re-open.
 */
export function hydrateMessagesFromSessionCache(conversationId: string): boolean {
  const meId = useAuthStore.getState().user?.id || '';
  if (!meId || !conversationId) return false;
  const existing = useChatStore.getState().messages[conversationId];
  if (existing?.length) {
    const hasCipher = existing.some(
      (m) => typeof m.content === 'string' && m.content.startsWith('🔐e2e:')
    );
    if (!hasCipher) return true;
  }
  const cached = readCachedMessages(conversationId, meId);
  if (!cached?.messages.length) return false;
  useChatStore.getState().setMessages(conversationId, cached.messages, cached.hasMore);
  return true;
}

/**
 * Fetch a page of messages and decrypt on-device.
 * Single-flight: concurrent open/prefetch for the same chat share one request.
 */
export async function loadAndDecryptMessages(
  conversationId: string,
  opts?: {
    limit?: number;
    before?: string;
    refreshConversation?: boolean;
    /** Skip network if session cache is fresh (still returns cache). */
    allowStale?: boolean;
  }
): Promise<LoadedMessages> {
  const fk = flightKey(conversationId, opts?.before);
  const inflight = loadInFlight.get(fk);
  if (inflight) return inflight;

  const p = doLoad(conversationId, opts).finally(() => {
    loadInFlight.delete(fk);
  });
  loadInFlight.set(fk, p);
  return p;
}

async function doLoad(
  conversationId: string,
  opts?: {
    limit?: number;
    before?: string;
    refreshConversation?: boolean;
    allowStale?: boolean;
  }
): Promise<LoadedMessages> {
  const meId = useAuthStore.getState().user?.id || '';
  const isInitialPage = !opts?.before;

  // Fresh session cache → skip network entirely for initial open
  if (isInitialPage && opts?.allowStale !== false && meId) {
    const cached = readCachedMessages(conversationId, meId);
    if (cached?.fresh) {
      // Background revalidate without blocking UI
      void doNetworkLoad(conversationId, opts).then((fresh) => {
        useChatStore.getState().setMessages(conversationId, fresh.messages, fresh.hasMore);
        cacheMessages(conversationId, meId, fresh.messages, fresh.hasMore);
      });
      return {
        messages: cached.messages,
        hasMore: cached.hasMore,
        fromCache: true,
      };
    }
  }

  return doNetworkLoad(conversationId, opts);
}

async function doNetworkLoad(
  conversationId: string,
  opts?: {
    limit?: number;
    before?: string;
    refreshConversation?: boolean;
  }
): Promise<LoadedMessages> {
  const meId = useAuthStore.getState().user?.id || '';
  // Static-ish import path: module already preloaded from main.tsx when possible
  const e2eModP = import('../services/e2e');

  // Warm crypto in parallel with messages. Always refresh conversation when we
  // lack E2E wraps — without them post-refresh decrypt shows "Encrypted message".
  const warmP = (async () => {
    if (!meId) return;
    try {
      const { warmConversationCrypto } = await e2eModP;
      let conv = useChatStore.getState().conversations.find((c) => c.id === conversationId);
      const needsFull =
        opts?.refreshConversation ||
        !conv ||
        !conv.participants?.length ||
        !conv.e2eWrappedKeys?.some((k) => k.wrappedKey);
      if (needsFull) {
        try {
          const full = await chatService.getConversation(conversationId);
          useChatStore.getState().upsertConversation({
            id: full.id,
            participants: full.participants,
            e2eWrappedKeys: full.e2eWrappedKeys,
            e2eVersion: full.e2eVersion,
            type: full.type,
            displayName: full.displayName,
            name: full.name,
            avatar: full.avatar,
          } as typeof full);
          conv = { ...(conv || full), ...full };
        } catch {
          /* */
        }
      }
      if (conv) await warmConversationCrypto(conv, meId);
    } catch {
      /* */
    }
  })();

  const [data] = await Promise.all([
    chatService.getMessages(conversationId, {
      // Smaller first page = faster TTFP on tunnel/mobile
      limit: opts?.limit ?? 20,
      before: opts?.before,
    }),
    warmP,
  ]);

  let messages = data.messages;
  if (meId) {
    try {
      const { decryptMessages, ensureConversationE2E, isE2ECiphertext } = await e2eModP;
      let conv = useChatStore.getState().conversations.find((c) => c.id === conversationId);

      // If history has ciphertext but still no wraps, force one more conversation GET
      const hasCipher = messages.some(
        (m) => typeof m.content === 'string' && m.content.startsWith('🔐e2e:')
      );
      if (
        hasCipher &&
        (!conv?.e2eWrappedKeys?.some((k) => k.wrappedKey) || !conv?.participants?.length)
      ) {
        try {
          const full = await chatService.getConversation(conversationId);
          useChatStore.getState().upsertConversation({
            id: full.id,
            participants: full.participants,
            e2eWrappedKeys: full.e2eWrappedKeys,
            e2eVersion: full.e2eVersion,
          } as typeof full);
          conv = { ...(conv || full), ...full };
        } catch {
          /* */
        }
      }

      if (conv) {
        const ensured = await ensureConversationE2E(conv, meId, { redistribute: false });
        if (ensured) {
          useChatStore.getState().upsertConversation({
            id: ensured.id,
            e2eWrappedKeys: ensured.e2eWrappedKeys,
            e2eVersion: ensured.e2eVersion,
            participants: ensured.participants,
          } as typeof ensured);
          conv = { ...conv, ...ensured };
          void ensureConversationE2E(ensured, meId, { redistribute: true }).then((updated) => {
            if (!updated) return;
            useChatStore.getState().upsertConversation({
              id: updated.id,
              e2eWrappedKeys: updated.e2eWrappedKeys,
              e2eVersion: updated.e2eVersion,
              participants: updated.participants,
            } as typeof updated);
          });
        }
      }
      messages = await decryptMessages(conv, meId, messages);
      // Second pass if any envelopes remain (key often lands just after first attempt)
      if (messages.some((m) => isE2ECiphertext(m.content))) {
        const again = useChatStore.getState().conversations.find((c) => c.id === conversationId);
        messages = await decryptMessages(again || conv, meId, messages);
      }
      messages = messages.map((m) =>
        isE2ECiphertext(m.content) ? { ...m, content: '🔒 Encrypted message' } : m
      );
    } catch {
      messages = stripCipherEnvelopes(messages);
    }
  }

  if (meId && !opts?.before) {
    cacheMessages(conversationId, meId, messages, data.hasMore);
  }

  return { messages, hasMore: data.hasMore };
}

/**
 * Prefetch decrypted messages into the store if the thread is empty.
 */
export function prefetchConversationMessages(
  conversationId: string,
  opts?: { limit?: number }
): Promise<LoadedMessages | null> {
  const existing = useChatStore.getState().messages[conversationId];
  if (existing?.length) {
    const hasCipher = existing.some(
      (m) => typeof m.content === 'string' && m.content.startsWith('🔐e2e:')
    );
    if (!hasCipher) {
      const meId = useAuthStore.getState().user?.id || '';
      if (meId) {
        void import('../services/e2e').then(({ warmConversationCrypto }) => {
          const conv = useChatStore.getState().conversations.find((c) => c.id === conversationId);
          void warmConversationCrypto(conv, meId);
        });
      }
      return Promise.resolve(null);
    }
  }

  // Paint session cache immediately while network runs
  hydrateMessagesFromSessionCache(conversationId);

  return loadAndDecryptMessages(conversationId, {
    limit: opts?.limit ?? 20,
  })
    .then((loaded) => {
      // Always apply network result; fromCache already matches session hydrate
      if (!loaded.fromCache) {
        useChatStore.getState().setMessages(conversationId, loaded.messages, loaded.hasMore);
      }
      return loaded;
    })
    .catch(() => null);
}
