import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Plus,
  Settings,
  Pin,
  Archive,
  Star,
  MessageSquare,
  Users,
  Loader2,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  Video,
  Monitor,
} from 'lucide-react';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { cn } from '@/shared/lib/cn';
import {
  formatCallDuration,
  formatChatListTime,
  getSender,
} from '@/shared/lib/format';
import { EmptyState } from '@/shared/ui/EmptyState';
import { useChatStore } from '../../store/chatStore';
import { useAuthStore } from '../../store/authStore';
import { useUIStore } from '../../store/uiStore';
import { useCallStore } from '../../store/callStore';
import { chatService } from '@/features/chat/services/chatService';
import { callService } from '@/features/chat/services/callService';
import { ensureSocketConnected } from '../../services/socket';
import { SwipeableChatRow } from './SwipeableChatRow';
import type { CallHistoryItem, Message, SidebarFilter } from '@/shared/types';
import toast from 'react-hot-toast';

const filters: {
  id: SidebarFilter;
  label: string;
  icon: typeof MessageSquare;
  empty: string;
}[] = [
  { id: 'all', label: 'Chats', icon: MessageSquare, empty: 'No conversations yet' },
  {
    id: 'groups',
    label: 'Groups',
    icon: Users,
    empty: 'No groups yet. Create a group with the + button.',
  },
  {
    id: 'calls',
    label: 'Calls',
    icon: Phone,
    empty: 'No calls yet. Place a voice or video call from a chat.',
  },
  {
    id: 'pinned',
    label: 'Pinned',
    icon: Pin,
    empty: 'No pinned messages yet. Long-press or ⋮ on a message and choose Pin.',
  },
  {
    id: 'favorites',
    label: 'Favorites',
    icon: Star,
    empty: 'No starred messages yet. Star a message from the message menu.',
  },
  {
    id: 'archived',
    label: 'Archived',
    icon: Archive,
    empty: 'No archived chats. Archive a chat from ⋮ in the chat header.',
  },
];

function callTitle(item: CallHistoryItem): string {
  const kind =
    item.callType === 'video' ? 'Video' : item.callType === 'screen' ? 'Screen' : 'Voice';
  if (item.status === 'missed') {
    return item.direction === 'incoming' ? `Missed ${kind.toLowerCase()} call` : `No answer`;
  }
  if (item.status === 'rejected') {
    return item.direction === 'incoming' ? 'Declined call' : 'Call declined';
  }
  if (item.status === 'completed') {
    return item.direction === 'incoming' ? `Incoming ${kind.toLowerCase()}` : `Outgoing ${kind.toLowerCase()}`;
  }
  return `${kind} call`;
}

function CallTypeIcon({ item }: { item: CallHistoryItem }) {
  const missed = item.status === 'missed' || item.status === 'rejected';
  const cls = cn('h-2.5 w-2.5 sm:h-3 sm:w-3', missed ? 'text-red-500' : 'text-emerald-500');
  if (item.callType === 'video') return <Video className={cls} />;
  if (item.callType === 'screen') return <Monitor className={cls} />;
  if (missed) return <PhoneMissed className={cls} />;
  return item.direction === 'incoming' ? (
    <PhoneIncoming className={cls} />
  ) : (
    <PhoneOutgoing className={cls} />
  );
}

function isPreviewLocked(content?: string | null): boolean {
  if (!content) return true;
  return (
    content.startsWith('🔐e2e:') ||
    content.startsWith('🔒') ||
    /^end[- ]to[- ]end/i.test(content.trim())
  );
}

function messagePreview(m: Message): string {
  if (m.isDeleted) return 'Message deleted';
  if (m.type === 'poll') return m.content?.trim() ? `📊 ${m.content}` : '📊 Poll';
  if (m.type === 'game') return m.content?.trim() ? `🎮 ${m.content}` : '🎮 Game';
  // Ciphertext / failed decrypt — never show raw envelopes or E2E marketing copy as preview
  if (isPreviewLocked(m.content)) {
    // Prefer attachment type when body is only a lock placeholder
    if (m.type && m.type !== 'text' && m.type !== 'system') return `📎 ${m.type}`;
    return 'Message';
  }
  if (m.content?.trim()) return m.content;
  if (m.type && m.type !== 'text') return `📎 ${m.type}`;
  return 'Empty message';
}

function preferPreviewMessage(
  server: Message | undefined,
  local: Message | undefined
): Message | undefined {
  if (!server) return local;
  if (!local) return server;
  const sCipher = isPreviewLocked(server.content);
  const lPlain = !!local.content && !isPreviewLocked(local.content);
  // Same message: keep local decrypted text over server ciphertext / lock
  if (server.id && local.id && server.id === local.id && sCipher && lPlain) {
    return { ...server, content: local.content, isE2E: local.isE2E };
  }
  // Different ids: never let a locked server preview wipe a readable local one
  if (sCipher && lPlain) return local;
  return server;
}

export function Sidebar() {
  const user = useAuthStore((s) => s.user);
  const conversations = useChatStore((s) => s.conversations);
  const setConversations = useChatStore((s) => s.setConversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const openConversationAtMessage = useChatStore((s) => s.openConversationAtMessage);
  const focusMessageId = useChatStore((s) => s.focusMessageId);
  const sidebarFilter = useChatStore((s) => s.sidebarFilter);
  const setSidebarFilter = useChatStore((s) => s.setSidebarFilter);
  const searchQuery = useChatStore((s) => s.searchQuery);
  const setSearchQuery = useChatStore((s) => s.setSearchQuery);
  const setShowSettings = useUIStore((s) => s.setShowSettings);
  const setShowNewChat = useUIStore((s) => s.setShowNewChat);
  const setShowNewGroup = useUIStore((s) => s.setShowNewGroup);
  const setShowMobileSidebar = useUIStore((s) => s.setShowMobileSidebar);
  const startCall = useCallStore((s) => s.startCall);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pullY, setPullY] = useState(0);
  const [messageItems, setMessageItems] = useState<Message[]>([]);
  const [callItems, setCallItems] = useState<CallHistoryItem[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const pullStart = useRef<number | null>(null);

  const isMessageFilter = sidebarFilter === 'pinned' || sidebarFilter === 'favorites';
  const isCallsFilter = sidebarFilter === 'calls';

  const refreshList = useCallback(async () => {
    setRefreshing(true);
    try {
      if (isCallsFilter) {
        const list = await callService.getHistory();
        setCallItems(list);
      } else if (isMessageFilter) {
        const list =
          sidebarFilter === 'pinned'
            ? await chatService.getPinnedMessages()
            : await chatService.getStarred();
        setMessageItems(Array.isArray(list) ? list : []);
      } else {
        const filterParam = sidebarFilter === 'archived' ? 'archived' : 'all';
        const list = await chatService.getConversations(filterParam);
        const { decryptAndSetConversations } = await import('../../utils/decryptConversationList');
        await decryptAndSetConversations(list, {
          cache: filterParam === 'all',
        });
      }
    } catch {
      toast.error('Could not refresh');
    } finally {
      setRefreshing(false);
      setPullY(0);
    }
  }, [isMessageFilter, isCallsFilter, sidebarFilter, setConversations]);

  // Always keep the main conversation list warm so opening a chat never blacks out.
  // Archived is a separate list; pin/favorites use message APIs.
  useEffect(() => {
    if (isMessageFilter || isCallsFilter) return;
    let cancelled = false;
    // Show cached rows immediately (bootstrap may have already hydrated)
    const existing = useChatStore.getState().conversations;
    if (existing.length > 0) {
      setLoading(false);
    } else {
      setLoading(true);
      // Sync disk cache for first paint before network returns
      void import('../../utils/sessionCache').then(async ({ readCachedConversations }) => {
        if (cancelled) return;
        const disk = readCachedConversations();
        if (disk?.length && !useChatStore.getState().conversations.length) {
          // Decrypt previews from disk cache (may still be ciphertext)
          const { decryptAndSetConversations } = await import(
            '../../utils/decryptConversationList'
          );
          if (cancelled) return;
          await decryptAndSetConversations(disk);
          if (!cancelled) setLoading(false);
        }
      });
    }
    const filterParam = sidebarFilter === 'archived' ? 'archived' : 'all';
    chatService
      .getConversations(filterParam)
      .then(async (list) => {
        if (cancelled) return;
        const prev = useChatStore.getState().conversations;
        // For "all", replace with server list (merge live fields). For archived, same.
        const merged = list.map((c) => {
          const old = prev.find((p) => p.id === c.id);
          if (!old) return c;
          const serverNewer =
            c.lastMessageAt && old.lastMessageAt
              ? new Date(c.lastMessageAt) >= new Date(old.lastMessageAt)
              : !!c.lastMessageAt;
          return {
            ...c,
            isOnline: old.isOnline ?? c.isOnline,
            unreadCount:
              typeof old.unreadCount === 'number' && old.unreadCount > (c.unreadCount || 0)
                ? old.unreadCount
                : c.unreadCount,
            lastMessage: serverNewer
              ? preferPreviewMessage(c.lastMessage, old.lastMessage)
              : preferPreviewMessage(old.lastMessage, c.lastMessage),
            lastMessageAt:
              c.lastMessageAt && old.lastMessageAt
                ? new Date(c.lastMessageAt) >= new Date(old.lastMessageAt)
                  ? c.lastMessageAt
                  : old.lastMessageAt
                : c.lastMessageAt || old.lastMessageAt,
            hasPinnedMessages:
              typeof c.hasPinnedMessages === 'boolean'
                ? c.hasPinnedMessages
                : old.hasPinnedMessages,
            hasStarredMessages:
              typeof c.hasStarredMessages === 'boolean'
                ? c.hasStarredMessages
                : old.hasStarredMessages,
            myPrefs: c.myPrefs ?? old.myPrefs,
            // Keep participants / e2e wraps for decrypt
            participants: c.participants?.length ? c.participants : old.participants,
            e2eWrappedKeys: c.e2eWrappedKeys?.length ? c.e2eWrappedKeys : old.e2eWrappedKeys,
            e2eVersion: c.e2eVersion ?? old.e2eVersion,
          };
        });
        const { decryptAndSetConversations } = await import(
          '../../utils/decryptConversationList'
        );
        if (cancelled) return;
        await decryptAndSetConversations(merged, { cache: filterParam === 'all' });
        // Warm top threads so opening a chat is near-instant (idle, sequential)
        if (!cancelled && filterParam === 'all') {
          const top = useChatStore
            .getState()
            .conversations.filter((c) => !c.myPrefs?.isArchived)
            .slice(0, 8);
          void import('../../utils/loadConversationMessages').then(
            async ({ prefetchConversationMessages }) => {
              // Prefetch top 3 in parallel first (most likely opens), then the rest
              const first = top.slice(0, 3);
              const rest = top.slice(3);
              await Promise.all(
                first.map((c) => prefetchConversationMessages(c.id, { limit: 20 }))
              );
              for (const c of rest) {
                if (cancelled) break;
                await prefetchConversationMessages(c.id, { limit: 20 });
                await new Promise((r) => setTimeout(r, 40));
              }
            }
          );
        }
      })
      .catch(() => {
        /* keep previous list */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sidebarFilter, isMessageFilter, isCallsFilter, setConversations]);

  // Prefetch main chat list once so Pinned/Favorites can open chats offline of current filter
  useEffect(() => {
    if (!isMessageFilter && !isCallsFilter) return;
    const existing = useChatStore.getState().conversations;
    if (existing.length > 0) return;
    let cancelled = false;
    chatService
      .getConversations('all')
      .then(async (list) => {
        if (cancelled || !list.length) return;
        const { decryptAndSetConversations } = await import(
          '../../utils/decryptConversationList'
        );
        await decryptAndSetConversations(list, { cache: true });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isMessageFilter, isCallsFilter, setConversations]);

  // Load pinned / starred messages
  useEffect(() => {
    if (!isMessageFilter) {
      setMessageItems([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const load =
      sidebarFilter === 'pinned'
        ? chatService.getPinnedMessages()
        : chatService.getStarred();
    load
      .then((list) => {
        if (!cancelled) setMessageItems(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setMessageItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sidebarFilter, isMessageFilter]);

  // Load call history
  useEffect(() => {
    if (!isCallsFilter) {
      setCallItems([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    callService
      .getHistory()
      .then((list) => {
        if (!cancelled) setCallItems(list);
      })
      .catch(() => {
        if (!cancelled) {
          setCallItems([]);
          toast.error('Could not load call history');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isCallsFilter, sidebarFilter]);

  const filteredConversations = useMemo(() => {
    let list = conversations;
    // Main Chats list never shows archived; Archived tab is server-filtered already
    if (sidebarFilter === 'all') {
      list = list.filter((c) => !c.myPrefs?.isArchived);
    } else if (sidebarFilter === 'groups') {
      list = list.filter((c) => c.type === 'group' && !c.myPrefs?.isArchived);
    }
    if (!searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase();
    return list.filter(
      (c) =>
        c.displayName?.toLowerCase().includes(q) ||
        c.name?.toLowerCase().includes(q) ||
        c.participants.some(
          (p) =>
            p.user.username?.toLowerCase().includes(q) ||
            p.user.displayName?.toLowerCase().includes(q)
        )
    );
  }, [conversations, searchQuery, sidebarFilter]);

  const filteredMessages = useMemo(() => {
    if (!searchQuery.trim()) return messageItems;
    const q = searchQuery.toLowerCase();
    return messageItems.filter(
      (m) =>
        m.content?.toLowerCase().includes(q) ||
        m.chatName?.toLowerCase().includes(q) ||
        getSender(m).displayName?.toLowerCase().includes(q)
    );
  }, [messageItems, searchQuery]);

  const filteredCalls = useMemo(() => {
    if (!searchQuery.trim()) return callItems;
    const q = searchQuery.toLowerCase();
    return callItems.filter(
      (c) =>
        c.otherUser.displayName?.toLowerCase().includes(q) ||
        c.otherUser.username?.toLowerCase().includes(q) ||
        c.callType.includes(q) ||
        c.status.includes(q)
    );
  }, [callItems, searchQuery]);

  const listEmpty = isCallsFilter
    ? filteredCalls.length === 0
    : isMessageFilter
      ? filteredMessages.length === 0
      : filteredConversations.length === 0;

  const openChatFromCall = async (item: CallHistoryItem) => {
    let convId = item.conversationId;
    if (!convId) {
      try {
        const conv = await chatService.createDirect(item.otherUser.id);
        useChatStore.getState().upsertConversation(conv);
        convId = conv.id;
      } catch {
        toast.error('Could not open chat');
        return;
      }
    } else {
      const store = useChatStore.getState();
      if (!store.conversations.some((c) => c.id === convId)) {
        try {
          const conv = await chatService.getConversation(convId);
          store.upsertConversation(conv);
        } catch {
          /* open anyway */
        }
      }
    }
    setActiveConversation(convId);
    setShowMobileSidebar(false);
  };

  const redial = async (item: CallHistoryItem, type: 'audio' | 'video') => {
    try {
      await openChatFromCall(item);
      const convId =
        item.conversationId ||
        useChatStore.getState().conversations.find((c) =>
          c.participants.some((p) => p.user.id === item.otherUser.id)
        )?.id;
      if (!convId) {
        toast.error('Could not start call');
        return;
      }
      await ensureSocketConnected();
      await startCall({
        conversationId: convId,
        remoteUserId: item.otherUser.id,
        callType: type,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      toast.error(
        /permission|NotAllowed|Media|denied/i.test(msg)
          ? 'Allow microphone/camera access to call'
          : msg || 'Could not start call'
      );
    }
  };

  return (
    <aside className="sidebar-shell flex h-full min-h-0 w-full flex-col md:w-[min(100%,340px)] lg:w-[380px]">
      {/* Compact header — more room for chats */}
      <div className="safe-top safe-x flex shrink-0 items-center justify-between gap-2 px-2.5 pb-2 pt-3 sm:px-3 sm:pb-2.5 sm:pt-4">
        <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
          <button
            type="button"
            className="pressable flex h-11 w-11 shrink-0 items-center justify-center touch-manipulation rounded-full ring-2 ring-transparent transition-[transform,box-shadow] duration-200 hover:scale-[1.03] hover:ring-pulse-500/30 active:scale-95"
            onClick={() => setShowSettings(true)}
            aria-label="Open profile settings"
          >
            <Avatar src={user?.avatar} name={user?.displayName} size="sm" online />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-[1.05rem] font-extrabold tracking-[-0.045em] sm:text-[1.15rem]">
              <span className="bg-gradient-to-r from-pulse-500 to-pulse-700 bg-clip-text text-transparent dark:from-pulse-300 dark:to-pulse-500">
                Pulse
              </span>
            </h1>
            <p className="truncate text-[11px] font-medium tracking-[-0.012em] text-[var(--color-ink-secondary)] sm:text-xs">
              @{user?.username}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="icon-btn h-11 w-11 text-[var(--color-ink-secondary)]"
            onClick={() => setShowNewChat(true)}
            title="New chat"
            aria-label="New chat"
          >
            <Plus className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="icon-btn h-11 w-11 text-[var(--color-ink-secondary)]"
            onClick={() => setShowNewGroup(true)}
            title="New group"
            aria-label="New group"
          >
            <Users className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="icon-btn h-11 w-11 text-[var(--color-ink-secondary)]"
            onClick={() => setShowSettings(true)}
            title="Settings"
            aria-label="Settings"
          >
            <Settings className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="safe-x shrink-0 px-2.5 py-1.5 sm:px-3 sm:py-2">
        <div className="search-field relative rounded-2xl">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-secondary)] opacity-80" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={
              isCallsFilter
                ? 'Search calls…'
                : isMessageFilter
                  ? 'Search messages…'
                  : 'Search chats…'
            }
            enterKeyHint="search"
            className="min-h-11 w-full rounded-2xl border-0 bg-transparent py-2.5 pl-10 pr-4 text-base tracking-[-0.01em] outline-none placeholder:text-[var(--color-ink-secondary)]/60 sm:min-h-10 sm:py-2 sm:text-sm"
          />
        </div>
      </div>

      {/* Filters */}
      <div className="safe-x chip-scroll shrink-0 px-2.5 pb-2.5 sm:px-3">
        {filters.map((f) => {
          const Icon = f.icon;
          const active = sidebarFilter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setSidebarFilter(f.id)}
              className={cn(
                'filter-chip flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold tracking-[-0.01em] touch-manipulation',
                active && 'filter-chip-active'
              )}
            >
              <Icon className={cn('h-3.5 w-3.5', active ? 'opacity-100' : 'opacity-80')} />
              {f.label}
            </button>
          );
        })}
      </div>

      {/* List + pull-to-refresh */}
      <div
        ref={listRef}
        className="scroll-pane min-h-0 flex-1 overflow-x-hidden overscroll-y-contain scrollbar-thin pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-0.5"
        onTouchStart={(e) => {
          const el = listRef.current;
          if (!el || el.scrollTop > 0) {
            pullStart.current = null;
            return;
          }
          pullStart.current = e.touches[0].clientY;
        }}
        onTouchMove={(e) => {
          if (pullStart.current == null || refreshing) return;
          const el = listRef.current;
          if (!el || el.scrollTop > 0) return;
          const dy = e.touches[0].clientY - pullStart.current;
          if (dy > 0) setPullY(Math.min(72, dy * 0.45));
        }}
        onTouchEnd={() => {
          if (pullY > 48 && !refreshing) void refreshList();
          else setPullY(0);
          pullStart.current = null;
        }}
      >
        <div
          className="ptr-hint flex items-center justify-center overflow-hidden text-xs text-[var(--color-ink-secondary)]"
          style={{ height: refreshing ? 40 : pullY, opacity: refreshing || pullY > 12 ? 1 : 0.5 }}
        >
          {refreshing || pullY > 24 ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
              {refreshing ? 'Refreshing…' : 'Release to refresh'}
            </span>
          ) : null}
        </div>
        {loading ? (
          <div className="space-y-1 p-3">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-2xl p-2.5">
                <div className="skeleton h-12 w-12 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex justify-between gap-2">
                    <div className="skeleton h-3 w-[42%]" />
                    <div className="skeleton h-2.5 w-9" />
                  </div>
                  <div className="skeleton h-3 w-[72%]" />
                </div>
              </div>
            ))}
          </div>
        ) : listEmpty ? (
          <EmptyState
            className="py-20"
            icon={filters.find((f) => f.id === sidebarFilter)?.icon || MessageSquare}
            title={sidebarFilter === 'all' ? 'No conversations yet' : 'Nothing here yet'}
            description={
              filters.find((f) => f.id === sidebarFilter)?.empty ||
              'Start a new chat to begin messaging'
            }
            action={
              sidebarFilter === 'all' ? (
                <Button onClick={() => setShowNewChat(true)}>New chat</Button>
              ) : undefined
            }
          />
        ) : isCallsFilter ? (
          <div
            key={`calls-${sidebarFilter}`}
            className="filter-list-enter w-full max-w-full min-w-0 overflow-x-hidden"
          >
            {filteredCalls.map((item) => {
              const subtitle = [
                callTitle(item),
                item.status === 'completed' && item.durationSec > 0
                  ? formatCallDuration(item.durationSec)
                  : null,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <div
                  key={item.id}
                  className="chat-row touch-row box-border flex w-full max-w-full min-w-0 items-center gap-2 overflow-hidden px-2.5 py-2.5 text-left sm:gap-3 sm:px-4 sm:py-3"
                >
                  <button
                    type="button"
                    className="pressable flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden text-left sm:gap-3"
                    onClick={() => void openChatFromCall(item)}
                  >
                    <div className="relative shrink-0">
                      <Avatar
                        src={item.otherUser.avatar || undefined}
                        name={item.otherUser.displayName}
                        size="md"
                        className="!h-11 !w-11 sm:!h-12 sm:!w-12"
                      />
                      <span className="pointer-events-none absolute bottom-0 right-0 flex h-4 w-4 translate-x-0.5 translate-y-0.5 items-center justify-center rounded-full border-2 border-[var(--color-surface-elevated)] bg-[var(--color-surface)] sm:h-5 sm:w-5">
                        <CallTypeIcon item={item} />
                      </span>
                    </div>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.02em]">
                          {item.otherUser.displayName}
                        </span>
                        <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-ink-secondary)]/80 sm:text-[11px]">
                          {formatChatListTime(item.startedAt)}
                        </span>
                      </div>
                      <p
                        className={cn(
                          'mt-0.5 truncate text-[12px] leading-snug sm:text-[13px]',
                          item.status === 'missed' || item.status === 'rejected'
                            ? 'font-medium text-red-500'
                            : 'text-[var(--color-ink-secondary)]'
                        )}
                      >
                        {subtitle}
                      </p>
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 sm:h-10 sm:w-10"
                      title="Voice call"
                      aria-label={`Call ${item.otherUser.displayName}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void redial(item, 'audio');
                      }}
                    >
                      <Phone className="h-4 w-4 text-pulse-500" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 sm:h-10 sm:w-10"
                      title="Video call"
                      aria-label={`Video call ${item.otherUser.displayName}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void redial(item, 'video');
                      }}
                    >
                      <Video className="h-4 w-4 text-pulse-500" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : isMessageFilter ? (
          <div key={`msgs-${sidebarFilter}`} className="filter-list-enter">
          {filteredMessages.map((msg) => {
            const sender = getSender(msg);
            const convId = String(msg.conversation);
            const active =
              convId === activeConversationId && focusMessageId === msg.id;
            return (
              <button
                key={msg.id}
                type="button"
                onClick={async () => {
                  const store = useChatStore.getState();
                  if (!store.conversations.some((c) => c.id === convId)) {
                    try {
                      const conv = await chatService.getConversation(convId);
                      store.upsertConversation(conv);
                    } catch {
                      /* ChatWindow will retry / show error */
                    }
                  }
                  openConversationAtMessage(convId, msg.id);
                  setShowMobileSidebar(false);
                }}
                className={cn(
                  'chat-row touch-row pressable flex w-full items-start gap-3 px-3 py-3.5 text-left sm:px-4 sm:py-3',
                  active && 'chat-row-active'
                )}
              >
                <div className="relative mt-0.5 shrink-0">
                  <Avatar src={sender.avatar} name={sender.displayName} size="md" />
                  <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-[var(--color-surface-elevated)] bg-pulse-500 text-white">
                    {sidebarFilter === 'pinned' ? (
                      <Pin className="h-2.5 w-2.5" />
                    ) : (
                      <Star className="h-2.5 w-2.5 fill-white" />
                    )}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold">
                      {msg.chatName || 'Chat'}
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--color-ink-secondary)]">
                      {formatChatListTime(msg.createdAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-[var(--color-ink-secondary)]">
                    {sender.displayName}
                    {sender.id === user?.id ? ' (you)' : ''}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-sm text-[var(--color-ink-secondary)]">
                    {messagePreview(msg)}
                  </p>
                </div>
              </button>
            );
          })}
          </div>
        ) : (
          <div key={`convs-${sidebarFilter}`} className="filter-list-enter space-y-0.5 py-0.5">
          {filteredConversations.map((conv) => {
            const active = conv.id === activeConversationId;
            const last = conv.lastMessage;
            const preview = last
              ? messagePreview(last)
              : 'No messages yet';
            const unread = conv.unreadCount || 0;

            return (
              <SwipeableChatRow
                key={conv.id}
                active={active}
                label={[
                  conv.type === 'group' ? 'Group chat' : 'Chat',
                  `with ${conv.displayName}`,
                  unread > 0 ? `, ${unread} unread message${unread === 1 ? '' : 's'}` : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                enabled={typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches}
                onOpen={() => {
                  setActiveConversation(conv.id);
                  setShowMobileSidebar(false);
                }}
                onPin={() => {
                  void chatService
                    .updatePrefs(conv.id, { isPinned: !conv.myPrefs?.isPinned })
                    .then((updated) => {
                      useChatStore.getState().upsertConversation(updated);
                      toast.success(updated.myPrefs?.isPinned ? 'Pinned' : 'Unpinned');
                    })
                    .catch(() => toast.error('Could not pin'));
                }}
                onDelete={() => {
                  if (!window.confirm(`Delete chat with ${conv.displayName}?`)) return;
                  void chatService
                    .deleteConversationForMe(conv.id)
                    .then(() => {
                      useChatStore.getState().removeConversation(conv.id);
                      toast.success('Chat deleted');
                    })
                    .catch(() => toast.error('Could not delete'));
                }}
                onArchive={() => {
                  void chatService
                    .updatePrefs(conv.id, { isArchived: true })
                    .then(() => {
                      useChatStore.getState().removeConversation(conv.id);
                      toast.success('Archived');
                    })
                    .catch(() => toast.error('Could not archive'));
                }}
                onMarkUnread={() => {
                  useChatStore.setState((s) => ({
                    conversations: s.conversations.map((c) =>
                      c.id === conv.id
                        ? { ...c, unreadCount: Math.max(1, c.unreadCount || 0) }
                        : c
                    ),
                  }));
                  toast.success('Marked unread');
                }}
              >
                <div
                  className="contents"
                  onPointerEnter={() => {
                    void import('../../utils/loadConversationMessages').then(
                      ({ prefetchConversationMessages }) =>
                        prefetchConversationMessages(conv.id, { limit: 20 })
                    );
                  }}
                  onPointerDown={() => {
                    // Start fetch on finger/mouse down — often finishes before click handler
                    void import('../../utils/loadConversationMessages').then(
                      ({ prefetchConversationMessages }) =>
                        prefetchConversationMessages(conv.id, { limit: 20 })
                    );
                  }}
                >
                  <Avatar
                    src={conv.avatar}
                    name={conv.displayName}
                    size="md"
                    online={conv.type === 'direct' ? conv.isOnline : undefined}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          'truncate text-[15px] tracking-[-0.02em]',
                          unread > 0 ? 'font-bold' : 'font-semibold'
                        )}
                      >
                        {conv.displayName}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 text-[11px] tabular-nums',
                          unread > 0
                            ? 'font-semibold text-pulse-500'
                            : 'text-[var(--color-ink-secondary)]/80'
                        )}
                      >
                        {formatChatListTime(conv.lastMessageAt)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <p
                        className={cn(
                          'truncate text-[13px] leading-snug sm:text-sm',
                          unread > 0
                            ? 'font-medium text-[var(--color-ink)]'
                            : 'text-[var(--color-ink-secondary)]'
                        )}
                      >
                        {preview}
                      </p>
                      <div className="flex shrink-0 items-center gap-1">
                        {conv.myPrefs?.isPinned && (
                          <Pin className="pin-indicator h-3 w-3" />
                        )}
                        {conv.myPrefs?.isFavorite && (
                          <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                        )}
                        {unread > 0 && (
                          <span className="unread-badge badge-pop ring-2 ring-[var(--color-surface-elevated)]">
                            {unread > 99 ? '99+' : unread}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </SwipeableChatRow>
            );
          })}
          </div>
        )}
      </div>
    </aside>
  );
}
