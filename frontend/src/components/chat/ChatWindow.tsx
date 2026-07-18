import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Phone,
  Video,
  MoreVertical,
  ArrowLeft,
  Pin,
  Archive,
  Star,
  BellOff,
  Search,
  Monitor,
  Trash2,
  Users,
  Gamepad2,
} from 'lucide-react';
import { GamesPanel } from './play/GamesPanel';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { UserProfileModal } from './UserProfileModal';
import { GroupInfoModal } from './GroupInfoModal';
import { GroupCallPicker } from '../call/GroupCallPicker';
import { useChatStore } from '../../store/chatStore';
import { useAuthStore } from '../../store/authStore';
import { useUIStore } from '../../store/uiStore';
import { useCallStore } from '../../store/callStore';
import { chatService } from '../../services/chat.service';
import { ensureSocketConnected, getSocket } from '../../services/socket';
import { webrtc } from '../../services/webrtc';
import { formatDateSeparator, formatLastSeen, isDifferentDay } from '../../utils/format';
import {
  hydrateMessagesFromSessionCache,
  loadAndDecryptMessages,
} from '../../utils/loadConversationMessages';
import { cacheMessages } from '../../utils/messageCache';
import { getChatBackground } from '../../shared/lib/chatBackgrounds';
import {
  afterNextPaint,
  prefersReducedMotion,
  rafThrottle,
  smoothScrollToBottom,
} from '../../shared/lib/raf';
import toast from 'react-hot-toast';
import type { CallType, Message } from '../../types';

const EMPTY_MSGS: Message[] = [];
const EMPTY_TYPING: string[] = [];

export function ChatWindow() {
  const user = useAuthStore((s) => s.user);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  // Narrow subscriptions: only the active thread re-renders on new messages/typing
  const conversation = useChatStore((s) =>
    s.activeConversationId
      ? s.conversations.find((c) => c.id === s.activeConversationId)
      : undefined
  );
  const msgs = useChatStore((s) =>
    s.activeConversationId ? s.messages[s.activeConversationId] || EMPTY_MSGS : EMPTY_MSGS
  );
  const hasMoreForActive = useChatStore((s) =>
    s.activeConversationId ? !!s.hasMore[s.activeConversationId] : false
  );
  const typingUsers = useChatStore((s) =>
    s.activeConversationId ? s.typing[s.activeConversationId] || EMPTY_TYPING : EMPTY_TYPING
  );
  const focusMessageId = useChatStore((s) => s.focusMessageId);
  const setMessages = useChatStore((s) => s.setMessages);
  const prependMessages = useChatStore((s) => s.prependMessages);
  const clearUnread = useChatStore((s) => s.clearUnread);
  const setFocusMessageId = useChatStore((s) => s.setFocusMessageId);
  const upsertConversation = useChatStore((s) => s.upsertConversation);
  const setShowMobileSidebar = useUIStore((s) => s.setShowMobileSidebar);
  const chatBackgroundId = useUIStore((s) => s.chatBackground);
  const chatBg = getChatBackground(chatBackgroundId);
  const startCall = useCallStore((s) => s.startCall);
  const startGroupCall = useCallStore((s) => s.startGroupCall);

  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [resolvingConv, setResolvingConv] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState<typeof EMPTY_MSGS>([]);
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [deletingChat, setDeletingChat] = useState(false);
  const [groupCallOpen, setGroupCallOpen] = useState(false);
  const [groupCallDefaultType, setGroupCallDefaultType] = useState<CallType>('audio');
  const [showGames, setShowGames] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const prevHeight = useRef(0);
  const stickToBottom = useRef(true);
  const loadingMoreRef = useRef(false);
  const lastMsgId = useRef<string | null>(null);
  const loadGen = useRef(0);

  // ——— ALL HOOKS MUST BE ABOVE ANY CONDITIONAL RETURN ———

  // If chat was opened from Pinned/Favorites, conversation may not be in the list yet
  useEffect(() => {
    if (!activeConversationId || conversation) {
      setResolvingConv(false);
      return;
    }
    let cancelled = false;
    setResolvingConv(true);
    chatService
      .getConversation(activeConversationId)
      .then((conv) => {
        if (!cancelled && conv) upsertConversation(conv);
      })
      .catch(() => {
        if (!cancelled) {
          toast.error('Could not open chat');
          useChatStore.getState().setActiveConversation(null);
          setShowMobileSidebar(true);
        }
      })
      .finally(() => {
        if (!cancelled) setResolvingConv(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeConversationId, conversation, upsertConversation, setShowMobileSidebar]);

  /** Jump scroller to the newest message (instant — used on open / reload). */
  const scrollToLatest = useCallback((behavior: 'auto' | 'smooth' = 'auto') => {
    const el = scrollerRef.current;
    if (!el) return;
    stickToBottom.current = true;
    const jump = () => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      if (behavior === 'smooth' && !prefersReducedMotion()) {
        smoothScrollToBottom(scroller, 220);
      } else {
        scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
      }
    };
    // Double rAF so layout has applied new message rows
    afterNextPaint(jump);
    // Third pass after images/fonts may expand height
    window.setTimeout(jump, 50);
    window.setTimeout(jump, 200);
  }, []);

  const loadMessages = useCallback(async () => {
    if (!activeConversationId) return;
    const gen = ++loadGen.current;
    const convId = activeConversationId;
    const meId = useAuthStore.getState().user?.id || '';

    // Instant paint: memory → session cache (sync, no network)
    hydrateMessagesFromSessionCache(convId);
    const cached = useChatStore.getState().messages[convId];
    const hasCache = (cached?.length || 0) > 0;
    const cacheHasCipher = (cached || []).some(
      (m) => typeof m.content === 'string' && m.content.startsWith('🔐e2e:')
    );
    const cacheReady = hasCache && !cacheHasCipher;

    const openingAtMessage = !!useChatStore.getState().focusMessageId;
    if (!openingAtMessage) {
      stickToBottom.current = true;
      lastMsgId.current = null;
    }

    // Only skeleton when we have nothing readable
    if (!cacheReady) {
      setLoading(true);
    } else {
      setLoading(false);
      if (!openingAtMessage) {
        const last = cached![cached!.length - 1];
        lastMsgId.current = last?.id || null;
        scrollToLatest('auto');
      }
    }

    // Room join + read receipts off the critical path
    getSocket()?.emit('conversation:join', convId);
    void chatService.markRead(convId).then(() => {
      if (loadGen.current !== gen) return;
      clearUnread(convId);
      const list = useChatStore.getState().messages[convId];
      const lastId = list?.[list.length - 1]?.id;
      if (lastId) {
        getSocket()?.emit('message:read', {
          conversationId: convId,
          messageId: lastId,
        });
      }
    });

    try {
      // Reuses in-flight prefetch; may return fresh session cache without waiting
      const { messages, hasMore, fromCache } = await loadAndDecryptMessages(convId, {
        limit: 20,
      });
      if (loadGen.current !== gen) return;
      // fromCache already matches store if we hydrated; always apply network result
      if (!fromCache) {
        setMessages(convId, messages, hasMore);
        if (meId) cacheMessages(convId, meId, messages, hasMore);
      }
      // Sidebar preview: only promote a readable last message.
      // Never overwrite a good preview with "🔒 Encrypted message" after open/close.
      const last = messages[messages.length - 1];
      const lastReadable = [...messages]
        .reverse()
        .find(
          (m) =>
            !m.isDeleted &&
            m.type !== 'system' &&
            m.content &&
            !m.content.startsWith('🔐e2e:') &&
            !m.content.startsWith('🔒')
        );
      const preview = lastReadable || last;
      if (preview) {
        const existing = useChatStore.getState().conversations.find((c) => c.id === convId);
        if (existing) {
          const prevLm = existing.lastMessage;
          const prevOk =
            !!prevLm?.content &&
            !prevLm.content.startsWith('🔐e2e:') &&
            !prevLm.content.startsWith('🔒');
          const nextLocked =
            !preview.content ||
            preview.content.startsWith('🔐e2e:') ||
            preview.content.startsWith('🔒');
          // Keep existing readable preview if this open only produced a lock placeholder
          if (!(prevOk && nextLocked)) {
            useChatStore.getState().upsertConversation({
              id: existing.id,
              lastMessage: preview,
              lastMessageAt: preview.createdAt || existing.lastMessageAt,
            } as typeof existing);
          }
        }
      }
      if (!useChatStore.getState().focusMessageId) {
        lastMsgId.current = last?.id || null;
        scrollToLatest('auto');
      }
      if (last?.id) {
        getSocket()?.emit('message:read', {
          conversationId: convId,
          messageId: last.id,
        });
      }
    } catch {
      if (loadGen.current === gen && !cacheReady) toast.error('Failed to load messages');
    } finally {
      if (loadGen.current === gen) setLoading(false);
    }
  }, [activeConversationId, setMessages, clearUnread, scrollToLatest]);

  useEffect(() => {
    if (!activeConversationId) return;
    // Sync hydrate first frame so we never flash empty skeleton when cache exists
    hydrateMessagesFromSessionCache(activeConversationId);
    void loadMessages();
    return () => {
      loadGen.current += 1;
    };
  }, [loadMessages, activeConversationId]);

  // Reset scroll state every time the open conversation changes
  useEffect(() => {
    if (!activeConversationId) return;
    // Pin/star open keeps focusMessageId — don't force bottom in that case
    if (useChatStore.getState().focusMessageId) return;
    stickToBottom.current = true;
    lastMsgId.current = null;
    loadingMoreRef.current = false;
    // If messages are already cached, scroll immediately (loadMessages may skip skeleton)
    if ((useChatStore.getState().messages[activeConversationId] || []).length > 0) {
      scrollToLatest('auto');
    }
  }, [activeConversationId, scrollToLatest]);

  // After loading finishes, always land on the last message (normal open)
  useEffect(() => {
    if (!activeConversationId || loading || focusMessageId) return;
    if (!msgs.length) return;
    stickToBottom.current = true;
    const last = msgs[msgs.length - 1];
    lastMsgId.current = last?.id || null;
    scrollToLatest('auto');
  }, [activeConversationId, loading, focusMessageId, scrollToLatest]); // intentionally not msgs — only when open/load settles

  // Jump to a pinned/starred message when opened from the sidebar
  useEffect(() => {
    if (!focusMessageId || loading || !msgs.length) return;
    const exists = msgs.some((m) => m.id === focusMessageId);
    if (!exists) return;
    stickToBottom.current = false;
    const clearTimer = window.setTimeout(() => {
      setFocusMessageId(null);
    }, 3500);
    return () => window.clearTimeout(clearTimer);
  }, [focusMessageId, loading, msgs, setFocusMessageId]);

  // Auto-scroll only when user is near bottom / new own message (rAF-smoothed)
  useEffect(() => {
    if (focusMessageId) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const last = msgs[msgs.length - 1];
    const lastId = last?.id || null;
    if (!lastId || lastId === lastMsgId.current) {
      if (typingUsers.length && stickToBottom.current) {
        afterNextPaint(() => {
          if (!scrollerRef.current || !stickToBottom.current) return;
          if (prefersReducedMotion()) {
            scrollerRef.current.scrollTop =
              scrollerRef.current.scrollHeight - scrollerRef.current.clientHeight;
          } else {
            smoothScrollToBottom(scrollerRef.current, 220);
          }
        });
      }
      return;
    }
    lastMsgId.current = lastId;
    if (stickToBottom.current) {
      afterNextPaint(() => {
        if (!scrollerRef.current || !stickToBottom.current) return;
        // First few messages: jump; thereafter ease at display refresh rate
        if (msgs.length < 5 || prefersReducedMotion()) {
          scrollerRef.current.scrollTop =
            scrollerRef.current.scrollHeight - scrollerRef.current.clientHeight;
        } else {
          smoothScrollToBottom(scrollerRef.current, 280);
        }
      });
    }
  }, [msgs, typingUsers.length, focusMessageId]);

  // Close header ⋮ menu on outside click / Escape (must stay before any return)
  useEffect(() => {
    if (!showMenu) return;
    const onPointer = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowMenu(false);
    };
    const id = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointer, true);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [showMenu]);

  // Reset UI when switching chats
  useEffect(() => {
    setShowMenu(false);
    setSearchOpen(false);
    setSearchQ('');
    setSearchResults([]);
    setProfileUserId(null);
    setDeletingChat(false);
    setLoadingMore(false);
  }, [activeConversationId]);

  const loadMore = useCallback(async () => {
    if (
      !activeConversationId ||
      !hasMoreForActive ||
      loadingMoreRef.current ||
      !msgs.length
    )
      return;
    const convId = activeConversationId;
    const gen = loadGen.current;
    const beforeId = msgs[0].id;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    prevHeight.current = scrollerRef.current?.scrollHeight || 0;
    try {
      const { messages: older, hasMore } = await loadAndDecryptMessages(convId, {
        before: beforeId,
        limit: 20,
      });
      // Ignore if user switched chats mid-flight
      if (loadGen.current !== gen || useChatStore.getState().activeConversationId !== convId) {
        return;
      }
      prependMessages(convId, older, hasMore);
      afterNextPaint(() => {
        if (
          loadGen.current === gen &&
          scrollerRef.current &&
          useChatStore.getState().activeConversationId === convId
        ) {
          scrollerRef.current.scrollTop =
            scrollerRef.current.scrollHeight - prevHeight.current;
        }
      });
    } finally {
      if (loadGen.current === gen) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [activeConversationId, hasMoreForActive, msgs, prependMessages]);

  // One scroll-handler invocation per display frame (60/90/120 Hz)
  const onScroll = useMemo(
    () =>
      rafThrottle(() => {
        const el = scrollerRef.current;
        if (!el) return;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        stickToBottom.current = distanceFromBottom < 120;
        if (el.scrollTop < 80) {
          void loadMore();
        }
      }),
    [loadMore]
  );

  // ——— Renders (hooks finished) ———

  if (!activeConversationId) {
    return (
      <div className="relative hidden h-full w-full flex-1 flex-col items-center justify-center overflow-hidden bg-[var(--color-surface)] md:flex">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/4 top-1/3 h-64 w-64 -translate-x-1/2 rounded-full bg-pulse-500/10 blur-3xl" />
          <div className="absolute bottom-1/4 right-1/4 h-48 w-48 rounded-full bg-pulse-600/6 blur-3xl" />
        </div>
        <div className="animate-fade-up relative flex flex-col items-center px-8 text-center">
          <div className="relative mb-6">
            <div className="absolute inset-0 rounded-[28px] bg-pulse-500/25 blur-2xl" />
            <div className="relative flex h-[5.5rem] w-[5.5rem] items-center justify-center rounded-[28px] bg-gradient-to-br from-pulse-300 via-pulse-500 to-pulse-700 shadow-[0_20px_50px_rgba(10,132,255,0.35)] ring-4 ring-white/20 dark:ring-white/10">
              <svg viewBox="0 0 64 64" className="h-14 w-14 drop-shadow-sm">
                <path
                  d="M18 34c0-8 6-14 14-14s14 6 14 14c0 3-1 6-3 8l3 8-9-4c-1.5.5-3.2.8-5 .8-8 0-14-6-14-12.8z"
                  fill="white"
                />
              </svg>
            </div>
          </div>
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-pulse-500">
            Pulse
          </p>
          <h2 className="text-[1.4rem] font-bold tracking-[-0.035em]">Your messages, secured</h2>
          <p className="mt-2.5 max-w-sm text-sm leading-relaxed text-[var(--color-ink-secondary)]">
            Select a conversation from the sidebar, or start a new chat to begin messaging.
          </p>
          <div className="mt-6 flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-3.5 py-1.5 text-[11px] font-medium text-[var(--color-ink-secondary)] shadow-sm">
            <span aria-hidden>🔒</span>
            End-to-end encrypted
          </div>
        </div>
      </div>
    );
  }

  if (!conversation || resolvingConv) {
    return (
      <div className="flex h-full w-full flex-1 flex-col bg-[var(--color-surface)]">
        <div className="safe-top flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3 py-3">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => {
              useChatStore.getState().setActiveConversation(null);
              setShowMobileSidebar(true);
            }}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="skeleton h-10 w-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3 w-1/3" />
            <div className="skeleton h-2 w-1/4" />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-3 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className={`skeleton h-12 w-[55%] rounded-2xl ${i % 2 ? 'ml-auto' : ''}`}
            />
          ))}
        </div>
      </div>
    );
  }

  const otherParticipant = conversation.participants.find((p) => {
    const pid = p.user?.id;
    return pid && pid !== user?.id;
  });
  const remoteUserId = otherParticipant?.user?.id
    ? String(otherParticipant.user.id)
    : undefined;
  const otherUser = otherParticipant?.user;

  const openOtherProfile = () => {
    if (conversation.type === 'direct' && remoteUserId) {
      setProfileUserId(remoteUserId);
      return;
    }
    // Groups: open members list from header tap
    if (conversation.type === 'group') {
      setShowGroupInfo(true);
    }
  };

  const ensureCallContext = () => {
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) {
      toast.error('Calls require HTTPS (use the Cloudflare public URL)');
      return false;
    }
    return true;
  };

  const openGroupCallPicker = (type: CallType = 'audio') => {
    if (!ensureCallContext()) return;
    setGroupCallDefaultType(type === 'screen' ? 'video' : type);
    setGroupCallOpen(true);
  };

  const doGroupCall = (inviteUserIds: string[], type: CallType) => {
    if (!ensureCallContext()) return;
    void (async () => {
      try {
        await ensureSocketConnected();
        await startGroupCall({
          conversationId: conversation.id,
          inviteUserIds,
          callType: type,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        toast.error(
          /permission|NotAllowed|Media|denied/i.test(msg)
            ? 'Allow microphone/camera access to call'
            : /Socket|timeout|connect/i.test(msg)
              ? 'Not connected — refresh and try again'
              : msg || 'Could not start group call'
        );
      }
    })();
  };

  const doCall = (type: 'audio' | 'video' | 'screen') => {
    if (conversation.type === 'group') {
      openGroupCallPicker(type === 'screen' ? 'video' : type);
      return;
    }
    if (conversation.type !== 'direct') {
      toast.error('Calls are only available in chats');
      return;
    }
    if (!remoteUserId) {
      toast.error('Could not find the other user in this chat');
      return;
    }
    if (!ensureCallContext()) return;

    // Screen share: getDisplayMedia MUST run in this click turn (before any await).
    let displayPromise: Promise<MediaStream> | undefined;
    if (type === 'screen') {
      try {
        displayPromise = webrtc.requestDisplayMedia();
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Screen share failed';
        toast.error(msg);
        return;
      }
    }

    void (async () => {
      try {
        await ensureSocketConnected();
        await startCall({
          conversationId: conversation.id,
          remoteUserId,
          callType: type,
          displayPromise,
        });
        if (type === 'screen') {
          const surface = webrtc.localStream
            ?.getVideoTracks()[0]
            ?.getSettings() as MediaTrackSettings & { displaySurface?: string };
          const s = surface?.displaySurface;
          if (s === 'browser' || s === 'window') {
            toast(
              s === 'browser'
                ? 'For the whole desktop, pick “Entire Screen” (Chrome/Edge). Safari often only lists windows/tabs and pauses if minimized.'
                : 'Window share pauses when minimized. Prefer “Entire Screen” for a continuous feed.',
              { duration: 6000, icon: '🖥️' }
            );
          }
        }
      } catch (err) {
        // Stop orphaned display tracks if call setup failed after picker
        if (displayPromise) {
          void displayPromise
            .then((s) => s.getTracks().forEach((t) => t.stop()))
            .catch(() => undefined);
        }
        const msg = err instanceof Error ? err.message : '';
        toast.error(
          type === 'screen' && /permission|NotAllowed|denied|cancel|gesture|Abort/i.test(msg)
            ? 'Screen share cancelled or blocked by the browser'
            : /permission|NotAllowed|Media|denied/i.test(msg)
              ? 'Allow microphone/camera access to call'
              : /Socket|timeout|connect/i.test(msg)
                ? 'Not connected — refresh and try again'
                : /not supported|getDisplayMedia/i.test(msg)
                  ? 'Screen share is not supported in this browser'
                  : msg || 'Could not start call'
        );
      }
    })();
  };

  const updatePref = async (
    key: 'isPinned' | 'isArchived' | 'isFavorite' | 'isMuted',
    value: boolean
  ) => {
    try {
      const updated = await chatService.updatePrefs(conversation.id, { [key]: value });
      const store = useChatStore.getState();

      if (key === 'isArchived' && value) {
        // Drop from main list; Archived tab will re-fetch from server
        store.removeConversation(conversation.id);
        store.setActiveConversation(null);
        setShowMobileSidebar(true);
        store.setSidebarFilter('archived');
        toast.success('Chat archived — see Archived');
      } else if (key === 'isArchived' && !value) {
        // Unarchive: remove from Archived list view, show under Chats
        store.removeConversation(conversation.id);
        store.setActiveConversation(null);
        setShowMobileSidebar(true);
        store.setSidebarFilter('all');
        toast.success('Chat restored to Chats');
      } else {
        store.upsertConversation(updated);
        toast.success('Updated');
      }
    } catch {
      toast.error('Failed');
    }
    setShowMenu(false);
  };

  const deleteChat = async () => {
    if (deletingChat) return;
    const name = conversation.displayName || 'this chat';
    const ok = window.confirm(
      `Delete chat with ${name}?\n\nThis removes the conversation and message history for you only. Others keep their copy. If they message you again, the chat will reappear.`
    );
    if (!ok) {
      setShowMenu(false);
      return;
    }
    setDeletingChat(true);
    setShowMenu(false);
    try {
      await chatService.deleteConversationForMe(conversation.id);
      const store = useChatStore.getState();
      store.removeConversation(conversation.id);
      store.setActiveConversation(null);
      setShowMobileSidebar(true);
      store.setSidebarFilter('all');
      toast.success('Chat deleted');
    } catch {
      toast.error('Could not delete chat');
    } finally {
      setDeletingChat(false);
    }
  };

  const runSearch = async (q: string) => {
    setSearchQ(q);
    if (q.length < 2) {
      setSearchResults([]);
      return;
    }
    const results = await chatService.searchMessages(q, conversation.id);
    setSearchResults(results);
  };

  return (
    <div
      key={conversation.id}
      className="page-enter chat-pane relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col"
    >
      <header className="chat-header safe-top relative z-20 flex shrink-0 items-center justify-between gap-1 px-1.5 py-2 sm:px-3 sm:py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 text-[var(--color-ink-secondary)] md:hidden"
            aria-label="Back to chats"
            onClick={() => {
              useChatStore.getState().setActiveConversation(null);
              setShowMobileSidebar(true);
            }}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <button
            type="button"
            className="pressable flex min-w-0 flex-1 items-center gap-2.5 rounded-2xl px-1.5 py-1 text-left touch-manipulation transition-colors duration-150 hover:bg-black/[0.04] dark:hover:bg-white/[0.05] active:bg-black/5 dark:active:bg-white/5"
            onClick={openOtherProfile}
            aria-label={
              conversation.type === 'direct'
                ? `View ${conversation.displayName}'s profile`
                : 'Group info'
            }
          >
            <Avatar
              src={conversation.avatar}
              name={conversation.displayName}
              size="sm"
              online={conversation.type === 'direct' ? conversation.isOnline : undefined}
            />
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-semibold tracking-[-0.02em] sm:text-base">
                {conversation.displayName}
              </h2>
              <p className="status-line truncate text-[11px] tracking-[-0.01em] text-[var(--color-ink-secondary)] sm:text-xs">
                {typingUsers.length > 0 ? (
                  <span className="inline-flex items-center gap-1.5 font-medium text-pulse-500 animate-fade-in">
                    <span className="flex gap-0.5" aria-hidden>
                      <span className="typing-dot h-1.5 w-1.5 rounded-full bg-pulse-500" />
                      <span className="typing-dot h-1.5 w-1.5 rounded-full bg-pulse-500" />
                      <span className="typing-dot h-1.5 w-1.5 rounded-full bg-pulse-500" />
                    </span>
                    typing…
                  </span>
                ) : conversation.type === 'direct' ? (
                  <span className="inline-flex items-center gap-1.5 animate-fade-in">
                    <span className="e2e-badge" title="End-to-end encrypted">
                      🔒 E2E
                    </span>
                    <span
                      className={
                        conversation.isOnline ? 'status-online' : undefined
                      }
                    >
                      {formatLastSeen(conversation.lastSeen, conversation.isOnline)}
                    </span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 animate-fade-in">
                    <span className="e2e-badge" title="End-to-end encrypted">
                      🔒 E2E
                    </span>
                    {`${conversation.participants.length} members`}
                  </span>
                )}
              </p>
            </div>
          </button>
        </div>

        <div className="chat-header-actions relative flex max-w-[min(52%,18rem)] shrink-0 items-center justify-end gap-0 overflow-x-auto sm:max-w-none sm:gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="icon-btn shrink-0 text-[var(--color-ink-secondary)]"
            aria-label="Games history and leaderboard"
            title="Games"
            onClick={() => setShowGames(true)}
          >
            <Gamepad2 className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="icon-btn shrink-0 text-[var(--color-ink-secondary)]"
            aria-label="Search in chat"
            onClick={() => setSearchOpen(!searchOpen)}
          >
            <Search className="h-5 w-5" />
          </Button>
          {(conversation.type === 'direct' || conversation.type === 'group') && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="icon-btn shrink-0 text-[var(--color-ink-secondary)]"
                aria-label={conversation.type === 'group' ? 'Group voice call' : 'Voice call'}
                onClick={() => void doCall('audio')}
              >
                <Phone className="h-5 w-5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="icon-btn hidden shrink-0 text-[var(--color-ink-secondary)] md:inline-flex"
                aria-label={conversation.type === 'group' ? 'Group video call' : 'Video call'}
                onClick={() => void doCall('video')}
              >
                <Video className="h-5 w-5" />
              </Button>
              {conversation.type === 'direct' && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="icon-btn hidden shrink-0 text-[var(--color-ink-secondary)] xl:inline-flex"
                  aria-label="Share screen"
                  onClick={() => void doCall('screen')}
                >
                  <Monitor className="h-5 w-5" />
                </Button>
              )}
            </>
          )}
          <div className="relative" ref={menuRef}>
            <Button
              variant="ghost"
              size="icon"
              className="icon-btn text-[var(--color-ink-secondary)]"
              aria-haspopup="menu"
              aria-expanded={showMenu}
              aria-label="Chat options"
              onClick={() => setShowMenu((v) => !v)}
            >
              <MoreVertical className="h-5 w-5" />
            </Button>
            {showMenu && (
              <div
                role="menu"
                className="popover-enter absolute right-0 top-full z-[100] mt-1.5 w-[min(16rem,calc(100vw-1rem))] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)] py-1.5 shadow-[0_16px_48px_rgba(0,0,0,0.16)] ring-1 ring-black/[0.03] dark:ring-white/[0.04]"
                onPointerDown={(e) => e.stopPropagation()}
              >
                {conversation.type === 'direct' && (
                  <>
                    <MenuBtn
                      icon={<Video className="h-4 w-4" />}
                      label="Video call"
                      onClick={() => {
                        setShowMenu(false);
                        void doCall('video');
                      }}
                    />
                    <MenuBtn
                      icon={<Monitor className="h-4 w-4" />}
                      label="Share screen"
                      onClick={() => {
                        setShowMenu(false);
                        void doCall('screen');
                      }}
                    />
                    <div className="my-1 border-t border-[var(--color-border)]" />
                  </>
                )}
                {conversation.type === 'group' && (
                  <>
                    <MenuBtn
                      icon={<Phone className="h-4 w-4" />}
                      label="Group voice call"
                      onClick={() => {
                        setShowMenu(false);
                        openGroupCallPicker('audio');
                      }}
                    />
                    <MenuBtn
                      icon={<Video className="h-4 w-4" />}
                      label="Group video call"
                      onClick={() => {
                        setShowMenu(false);
                        openGroupCallPicker('video');
                      }}
                    />
                    <MenuBtn
                      icon={<Users className="h-4 w-4" />}
                      label="Group members"
                      onClick={() => {
                        setShowMenu(false);
                        setShowGroupInfo(true);
                      }}
                    />
                    <div className="my-1 border-t border-[var(--color-border)]" />
                  </>
                )}
                <MenuBtn
                  icon={<Pin className="h-4 w-4" />}
                  label={conversation.myPrefs?.isPinned ? 'Unpin' : 'Pin chat'}
                  onClick={() => void updatePref('isPinned', !conversation.myPrefs?.isPinned)}
                />
                <MenuBtn
                  icon={<Star className="h-4 w-4" />}
                  label={conversation.myPrefs?.isFavorite ? 'Unfavorite' : 'Favorite'}
                  onClick={() =>
                    void updatePref('isFavorite', !conversation.myPrefs?.isFavorite)
                  }
                />
                <MenuBtn
                  icon={<Archive className="h-4 w-4" />}
                  label={conversation.myPrefs?.isArchived ? 'Unarchive' : 'Archive'}
                  onClick={() =>
                    void updatePref('isArchived', !conversation.myPrefs?.isArchived)
                  }
                />
                <MenuBtn
                  icon={<BellOff className="h-4 w-4" />}
                  label={conversation.myPrefs?.isMuted ? 'Unmute' : 'Mute'}
                  onClick={() => void updatePref('isMuted', !conversation.myPrefs?.isMuted)}
                />
                <div className="my-1 border-t border-[var(--color-border)]" />
                <MenuBtn
                  icon={<Trash2 className="h-4 w-4" />}
                  label={deletingChat ? 'Deleting…' : 'Delete chat'}
                  danger
                  onClick={() => void deleteChat()}
                />
              </div>
            )}
          </div>
        </div>
      </header>

      {searchOpen && (
        <div className="animate-fade-in border-b border-[var(--color-border)] bg-[var(--color-surface-elevated)]/95 px-3 py-2.5 md:bg-[var(--color-surface-elevated)]/80 md:backdrop-blur-sm sm:px-4">
          <div className="search-field relative rounded-2xl">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-secondary)] opacity-80" />
            <input
              value={searchQ}
              onChange={(e) => void runSearch(e.target.value)}
              placeholder="Search in conversation…"
              className="min-h-11 w-full rounded-2xl border-0 bg-transparent py-2.5 pl-10 pr-3.5 text-base tracking-[-0.01em] outline-none sm:min-h-10 sm:text-sm"
              autoFocus
            />
          </div>
          {searchResults.length > 0 && (
            <div className="mt-2 max-h-40 space-y-0.5 overflow-y-auto scrollbar-thin">
              {searchResults.map((m) => (
                <div
                  key={m.id}
                  className="menu-item cursor-pointer rounded-xl px-3 py-2 text-sm"
                >
                  <p className="truncate tracking-[-0.01em]">{m.content}</p>
                </div>
              ))}
            </div>
          )}
          {searchQ.length >= 2 && searchResults.length === 0 && (
            <p className="mt-2 px-1 text-center text-xs text-[var(--color-ink-secondary)]">
              No matches in this chat
            </p>
          )}
        </div>
      )}

      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="relative z-0 min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain px-1 py-2.5 scrollbar-thin sm:px-2 sm:py-3 md:px-2.5 lg:px-3 [overflow-anchor:none]"
        style={{
          WebkitOverflowScrolling: 'touch',
          // Fixed attachment fights iOS compositing and causes scroll glitch
          backgroundColor: chatBg.style.backgroundColor,
          backgroundImage: chatBg.style.backgroundImage,
          backgroundSize: chatBg.style.backgroundSize || 'cover',
          backgroundAttachment: 'scroll',
          backgroundRepeat: chatBg.style.backgroundRepeat || 'no-repeat',
          backgroundPosition: chatBg.style.backgroundPosition || 'center',
          // Isolate scroll paint from header/composer
          transform: 'translateZ(0)',
        }}
      >
        {/* Full chat width so bubbles sit near the left/right edges (not a centered middle column) */}
        <div className="flex w-full flex-col">
        {loadingMore && (
          <div className="mb-4 flex justify-center">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-pulse-500 border-t-transparent opacity-80" />
          </div>
        )}
        {(loading && !msgs.length) ||
        msgs.some((m) => typeof m.content === 'string' && m.content.startsWith('🔐e2e:')) ? (
          <div className="space-y-3.5 px-1 animate-fade-in">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className={`skeleton h-12 w-[min(55%,16rem)] rounded-[20px] ${i % 2 ? 'ml-auto rounded-br-md' : 'rounded-bl-md'}`}
              />
            ))}
          </div>
        ) : msgs.length === 0 ? (
          <div className="animate-fade-up flex h-full min-h-[12rem] flex-col items-center justify-center px-6 py-16 text-center">
            <div className="empty-icon mb-4">
              <svg viewBox="0 0 64 64" className="h-8 w-8 text-pulse-500">
                <path
                  d="M18 34c0-8 6-14 14-14s14 6 14 14c0 3-1 6-3 8l3 8-9-4c-1.5.5-3.2.8-5 .8-8 0-14-6-14-12.8z"
                  fill="currentColor"
                  opacity="0.85"
                />
              </svg>
            </div>
            <p className="text-[15px] font-semibold tracking-[-0.02em]">No messages yet</p>
            <p className="mt-1.5 max-w-[16rem] text-sm leading-relaxed text-[var(--color-ink-secondary)]">
              Send a message to get started. Text is end-to-end encrypted when both of you have
              keys set up.
            </p>
          </div>
        ) : (
          msgs.map((msg, i) => {
            const prev = msgs[i - 1];
            const next = msgs[i + 1];
            const prevSender =
              prev && typeof prev.sender === 'object'
                ? (prev.sender as { id?: string }).id
                : prev?.sender;
            const nextSender =
              next && typeof next.sender === 'object'
                ? (next.sender as { id?: string }).id
                : next?.sender;
            const currSender =
              typeof msg.sender === 'object'
                ? (msg.sender as { id?: string }).id
                : msg.sender;
            const samePrev = !!prev && prevSender === currSender && prev.type !== 'system';
            const sameNext = !!next && nextSender === currSender && next.type !== 'system';
            // Group if within ~2 minutes
            const closePrev =
              samePrev &&
              Math.abs(
                new Date(msg.createdAt).getTime() - new Date(prev!.createdAt).getTime()
              ) < 120_000;
            const closeNext =
              sameNext &&
              Math.abs(
                new Date(next!.createdAt).getTime() - new Date(msg.createdAt).getTime()
              ) < 120_000;
            const showAvatar = !closePrev;
            const showDateSep = !prev || isDifferentDay(prev.createdAt, msg.createdAt);
            return (
              <div key={msg.id || msg.clientId}>
                {showDateSep && (
                  <div className="my-3 flex justify-center sm:my-4">
                    <span className="date-pill">{formatDateSeparator(msg.createdAt)}</span>
                  </div>
                )}
                <MessageBubble
                  message={msg}
                  showAvatar={showAvatar}
                  isGroup={conversation.type === 'group'}
                  highlighted={!!focusMessageId && msg.id === focusMessageId}
                  isFirstInGroup={!closePrev}
                  isLastInGroup={!closeNext}
                  compactTime={!closeNext}
                />
              </div>
            );
          })
        )}

        {typingUsers.length > 0 && (
          <div className="mb-2 flex items-center gap-2 animate-fade-in">
            <div className="bubble-in flex items-center gap-1.5 rounded-2xl rounded-bl-md bg-[var(--color-message-in)] px-3.5 py-2.5">
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-[var(--color-ink-secondary)]" />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-[var(--color-ink-secondary)]" />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-[var(--color-ink-secondary)]" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
        </div>
      </div>

      <MessageInput conversationId={conversation.id} />
      <GamesPanel
        conversationId={conversation.id}
        open={showGames}
        onClose={() => setShowGames(false)}
      />

      <UserProfileModal
        open={!!profileUserId}
        userId={profileUserId}
        onClose={() => setProfileUserId(null)}
        seed={
          (() => {
            if (conversation.type === 'direct' && otherUser) {
              return {
                id: otherUser.id,
                username: otherUser.username,
                displayName: otherUser.displayName,
                avatar: otherUser.avatar,
                bio: otherUser.bio,
                isOnline: otherUser.isOnline ?? conversation.isOnline,
                lastSeen: otherUser.lastSeen || conversation.lastSeen,
              };
            }
            // Group member selected from GroupInfoModal
            const m = conversation.participants.find((p) => p.user.id === profileUserId)?.user;
            if (!m) return null;
            return {
              id: m.id,
              username: m.username,
              displayName: m.displayName,
              avatar: m.avatar,
              bio: m.bio,
              isOnline: m.isOnline,
              lastSeen: m.lastSeen,
            };
          })()
        }
      />

      <GroupInfoModal
        open={showGroupInfo && conversation.type === 'group'}
        conversation={conversation.type === 'group' ? conversation : null}
        onClose={() => setShowGroupInfo(false)}
        onSelectMember={(userId) => {
          setShowGroupInfo(false);
          setProfileUserId(userId);
        }}
      />

      {conversation.type === 'group' && (
        <GroupCallPicker
          open={groupCallOpen}
          onClose={() => setGroupCallOpen(false)}
          conversation={conversation}
          mode="start"
          defaultCallType={groupCallDefaultType}
          onConfirm={({ inviteUserIds, callType }) => {
            doGroupCall(inviteUserIds, callType);
          }}
        />
      )}
    </div>
  );
}

function MenuBtn({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className={
        danger
          ? 'menu-item flex min-h-11 w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm font-medium tracking-[-0.01em] text-red-500 touch-manipulation'
          : 'menu-item flex min-h-11 w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm font-medium tracking-[-0.01em] text-[var(--color-ink)] touch-manipulation'
      }
    >
      <span className={danger ? 'text-red-500' : 'text-[var(--color-ink-secondary)]'}>{icon}</span>
      {label}
    </button>
  );
}
