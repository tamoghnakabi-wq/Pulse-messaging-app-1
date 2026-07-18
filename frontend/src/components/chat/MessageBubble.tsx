import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  CheckCheck,
  MoreHorizontal,
  Reply,
  Smile,
  Pin,
  X,
  Forward,
  Timer,
  Eye,
  EyeOff,
  Loader2,
} from 'lucide-react';
import { Avatar } from '../ui/Avatar';
import { cn } from '../../utils/cn';
import { formatMessageTime, formatFileSize, getSender } from '../../utils/format';
import { mediaUrl } from '../../utils/mediaUrl';
import type { Message } from '../../types';
import { useAuthStore } from '../../store/authStore';
import { useChatStore } from '../../store/chatStore';
import { chatService } from '../../services/chat.service';
import { MessageMenuItems } from '@/features/chat/components/message/MessageMenuItems';
import { decryptMediaAttachment, E2E_PREFIX, isE2EMediaMeta } from '../../services/e2e';
import { E2EMediaAttachment, isE2EAttachment } from './E2EMediaAttachment';
import { GameCard } from './play/GameCard';
import toast from 'react-hot-toast';

interface Props {
  message: Message;
  showAvatar?: boolean;
  isGroup?: boolean;
  highlighted?: boolean;
  /** First message in a consecutive same-sender group */
  isFirstInGroup?: boolean;
  /** Last message in group — show timestamp */
  isLastInGroup?: boolean;
  /** Soften timestamp on intermediate messages */
  compactTime?: boolean;
}

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const MENU_WIDTH = 208; // w-52
const REACT_WIDTH = 280;
/** Fresh messages animate in; history loads stay static (cheaper scroll). */
const FRESH_MSG_MS = 3500;
/** Skip ReactMarkdown when content has no markdown / links (most chat text). */
const MD_HINT = /[*_`#>[\]~|]|\n {0,3}[-*] |\n\d+\. |https?:\/\/|www\./;

function isPlainMessageText(text: string): boolean {
  return !MD_HINT.test(text);
}

/** Never paint raw E2E envelopes (looks like a “key” flashing on open). */
function isCipherEnvelope(text?: string | null): boolean {
  return typeof text === 'string' && text.startsWith(E2E_PREFIX);
}

/** Heavy markdown stack loads only when a bubble actually needs it. */
const MarkdownBody = lazy(() =>
  import('./MarkdownBody').then((m) => ({ default: m.MarkdownBody }))
);

type MenuPos = { top: number; left: number; openUp: boolean };

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function MessageBubbleInner({
  message,
  showAvatar,
  isGroup,
  highlighted,
  isFirstInGroup = true,
  isLastInGroup = true,
  compactTime = false,
}: Props) {
  const userId = useAuthStore((s) => s.user?.id);
  // Select actions only — never subscribe to full store (prevents N-bubble re-renders)
  const setReplyTo = useChatStore((s) => s.setReplyTo);
  const setEditingMessage = useChatStore((s) => s.setEditingMessage);
  // Conversation crypto context for E2E media decrypt
  const conversation = useChatStore((s) =>
    s.conversations.find((c) => c.id === message.conversation)
  );
  const [menu, setMenu] = useState(false);
  const [showReact, setShowReact] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  /** Shared in-app photo lightbox (normal + view-once) */
  const [lightbox, setLightbox] = useState<{
    url: string;
    viewOnce: boolean;
    title: string;
  } | null>(null);
  const [viewOnceLoading, setViewOnceLoading] = useState(false);
  const [reactPos, setReactPos] = useState<MenuPos | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const desktopMenuRef = useRef<HTMLDivElement>(null);
  const desktopReactRef = useRef<HTMLDivElement>(null);
  /**
   * Blocks reopen from ghost click / touch fall-through after closing the mobile sheet.
   * iOS/Android synthesize a click on whatever is under the finger after the sheet unmounts
   * — often the ⋮ button — so we arm a guard and disable that control briefly.
   */
  const menuGuardUntil = useRef(0);
  const [menuBtnLocked, setMenuBtnLocked] = useState(false);
  const lockTimer = useRef<number | null>(null);

  const armMenuGuard = useCallback((ms = 750) => {
    menuGuardUntil.current = Date.now() + ms;
    setMenuBtnLocked(true);
    if (lockTimer.current) window.clearTimeout(lockTimer.current);
    lockTimer.current = window.setTimeout(() => {
      setMenuBtnLocked(false);
      lockTimer.current = null;
    }, ms);
  }, []);

  const closeMenu = useCallback(
    (e?: { preventDefault?: () => void; stopPropagation?: () => void }) => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      armMenuGuard(750);
      setMenu(false);
      setShowReact(false);
    },
    [armMenuGuard]
  );

  const openMenu = useCallback(() => {
    if (Date.now() < menuGuardUntil.current) return;
    setShowReact(false);
    setMenu(true);
  }, []);

  const toggleMenu = useCallback(() => {
    if (Date.now() < menuGuardUntil.current) return;
    setShowReact(false);
    setMenu((v) => !v);
  }, []);

  useEffect(() => {
    return () => {
      if (lockTimer.current) window.clearTimeout(lockTimer.current);
    };
  }, []);

  const placeMenu = useCallback(() => {
    const btn = menuBtnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const pad = 8;
    const estH = 360;
    const spaceBelow = window.innerHeight - r.bottom - pad;
    const openUp = spaceBelow < Math.min(estH, 280) && r.top > spaceBelow;
    // Prefer aligning to the button edge that keeps the menu on-screen
    let left = r.left + r.width / 2 - MENU_WIDTH / 2;
    left = clamp(left, pad, window.innerWidth - MENU_WIDTH - pad);
    const top = openUp ? r.top - pad : r.bottom + pad;
    setMenuPos({ top, left, openUp });
  }, []);

  const placeReact = useCallback(() => {
    const btn = menuBtnRef.current || rootRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const pad = 8;
    const openUp = window.innerHeight - r.bottom < 64 && r.top > 64;
    let left = r.left + r.width / 2 - REACT_WIDTH / 2;
    left = clamp(left, pad, window.innerWidth - REACT_WIDTH - pad);
    const top = openUp ? r.top - pad : r.bottom + pad;
    setReactPos({ top, left, openUp });
  }, []);

  // Position desktop menus (portaled — avoids chat scroller clipping)
  useLayoutEffect(() => {
    if (!menu) {
      setMenuPos(null);
      return;
    }
    // Mobile uses bottom sheet; still compute for resize edge cases
    placeMenu();
    const onMove = () => placeMenu();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [menu, placeMenu]);

  useLayoutEffect(() => {
    if (!showReact) {
      setReactPos(null);
      return;
    }
    placeReact();
    const onMove = () => placeReact();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [showReact, placeReact]);

  // Close menus on outside click (portals live outside bubble DOM)
  useEffect(() => {
    if (!menu && !showReact) return;
    const onDoc = (e: Event) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (sheetRef.current?.contains(t)) return;
      if (desktopMenuRef.current?.contains(t)) return;
      if (desktopReactRef.current?.contains(t)) return;
      closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    // Defer so the opening tap doesn't immediately close
    const id = window.setTimeout(() => {
      document.addEventListener('pointerdown', onDoc, true);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu, showReact, closeMenu]);

  // Lock body scroll only for mobile sheets
  useEffect(() => {
    if (!menu && !showReact) return;
    const mobile = window.matchMedia('(max-width: 639px)').matches;
    if (!mobile) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [menu, showReact]);

  // Must stay before any conditional return (Rules of Hooks)
  useEffect(() => {
    if (!highlighted || !rootRef.current) return;
    rootRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlighted]);

  // Close in-app photo lightbox with Escape
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setLightbox(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightbox]);

  const sender = getSender(message);
  const isMine = sender.id === userId;
  const isSystem = message.type === 'system';
  const isGame = message.type === 'game' || !!message.gameId;
  const gameId =
    message.gameId ||
    (typeof (message as { gameId?: string }).gameId === 'string'
      ? (message as { gameId?: string }).gameId
      : undefined);

  // Normalize ids (ObjectId strings) so reload matches the opener
  const myId = userId ? String(userId) : '';
  const viewOnceViewedBy = (message.viewOnceViewedBy || [])
    .map((id) => {
      if (id == null) return '';
      if (typeof id === 'string') return id;
      if (typeof id === 'object' && id !== null) {
        const o = id as { _id?: unknown; id?: unknown; toString?: () => string };
        if (typeof o.toString === 'function') {
          const s = o.toString();
          if (s && s !== '[object Object]') return s;
        }
        if (o._id != null) return String(o._id);
        if (typeof o.id === 'string') return o.id;
      }
      return String(id);
    })
    .filter(Boolean);

  const listedAsOpenedByMe = !!myId && viewOnceViewedBy.includes(myId);
  // Server flag from GET /messages (viewer-specific) — trust when true
  const viewOnceOpenedByMe =
    !isMine && (message.viewOnceOpened === true || listedAsOpenedByMe);
  const viewOnceOpenedByAnyone =
    viewOnceViewedBy.length > 0 || (isMine && message.viewOnceOpened === true);
  // Never show "open" if we already opened (list or server flag)
  const viewOnceCanOpen =
    !!message.viewOnce && !isMine && !viewOnceOpenedByMe && message.viewOnceCanOpen !== false;
  const viewOnceShowOpened = isMine ? viewOnceOpenedByAnyone : viewOnceOpenedByMe;

  if (isSystem) {
    return (
      <div className="my-2.5 flex justify-center">
        <span className="rounded-full bg-black/[0.05] px-3.5 py-1 text-[11px] font-medium tracking-[-0.01em] text-[var(--color-ink-secondary)] dark:bg-white/[0.06]">
          {message.content}
        </span>
      </div>
    );
  }

  if (message.isDeleted) {
    return (
      <div className={cn('mb-1.5 flex', isMine ? 'justify-end' : 'justify-start')}>
        <div className="rounded-2xl border border-dashed border-[var(--color-border)] px-4 py-2 text-sm italic tracking-[-0.01em] text-[var(--color-ink-secondary)]">
          This message was deleted
        </div>
      </div>
    );
  }

  const delivered = (message.deliveredTo?.length || 0) > 1;
  const read = (message.readBy?.length || 0) > 1;
  const isFresh =
    !!message.createdAt &&
    Date.now() - new Date(message.createdAt).getTime() < FRESH_MSG_MS;
  const cipherPending = isCipherEnvelope(message.content);
  const plainContent =
    !cipherPending && message.content && isPlainMessageText(message.content)
      ? message.content
      : null;

  const handleReact = async (emoji: string) => {
    // Close first so ghost clicks can't reopen the options sheet
    closeMenu();
    const convId = String(message.conversation);
    const meId = useAuthStore.getState().user?.id || '';
    const userKey = (u: unknown) =>
      typeof u === 'string' ? u : u && typeof u === 'object' && 'id' in u
        ? String((u as { id: string }).id)
        : String(u ?? '');

    // Optimistic toggle — never wait on network / never re-apply ciphertext body
    const prevReactions = message.reactions || [];
    const optimisticReactions = (() => {
      const list = prevReactions.map((r) => ({
        emoji: r.emoji,
        users: [...(r.users || [])] as string[],
      }));
      const existing = list.find((r) => r.emoji === emoji);
      if (existing) {
        const hasMe = existing.users.some((u) => userKey(u) === meId);
        if (hasMe) {
          existing.users = existing.users.filter((u) => userKey(u) !== meId);
          return list.filter((r) => r.users.length > 0);
        }
        if (meId) existing.users = [...existing.users, meId];
        return list;
      }
      return [...list, { emoji, users: meId ? [meId] : [] }];
    })();
    useChatStore.getState().updateMessage(convId, {
      id: message.id,
      reactions: optimisticReactions,
    } as Message);

    try {
      const updated = await chatService.react(message.id, emoji);
      // Only patch reactions — server body is often still 🔐e2e:… and must not win
      useChatStore.getState().updateMessage(convId, {
        id: updated.id || message.id,
        reactions: updated.reactions ?? optimisticReactions,
      } as Message);
    } catch {
      useChatStore.getState().updateMessage(convId, {
        id: message.id,
        reactions: prevReactions,
      } as Message);
      toast.error('Could not react');
    }
  };

  const handleDeleteMe = async () => {
    closeMenu();
    try {
      await chatService.deleteForMe(message.id);
      useChatStore.getState().removeMessage(String(message.conversation), message.id);
    } catch {
      toast.error('Could not delete');
    }
  };

  const handleDeleteEveryone = async () => {
    closeMenu();
    try {
      const updated = await chatService.deleteForEveryone(message.id);
      useChatStore.getState().updateMessage(String(message.conversation), updated);
    } catch {
      toast.error('Could not delete');
    }
  };

  const handlePin = async () => {
    closeMenu();
    try {
      const updated = await chatService.pin(message.id);
      const convId = String(message.conversation);
      const store = useChatStore.getState();
      store.updateMessage(convId, updated);
      const conv = store.conversations.find((c) => c.id === convId);
      if (conv) {
        store.upsertConversation({
          ...conv,
          hasPinnedMessages: !!updated.isPinned,
        });
      }
      toast.success(
        updated.isPinned ? 'Message pinned — open Pinned in the sidebar' : 'Message unpinned'
      );
    } catch {
      toast.error('Could not pin message');
    }
  };

  const openNormalPhoto = (url: string, name?: string) => {
    setLightbox({
      url,
      viewOnce: false,
      title: name || 'Photo',
    });
  };

  const markViewOnceOpenedLocally = (extra?: Partial<Message>) => {
    const nextViewed = viewOnceViewedBy.includes(myId)
      ? viewOnceViewedBy
      : [...viewOnceViewedBy, myId].filter(Boolean);
    useChatStore.getState().updateMessage(String(message.conversation), {
      ...message,
      ...extra,
      viewOnce: true,
      viewOnceOpened: true,
      viewOnceCanOpen: false,
      viewOnceViewedBy: nextViewed,
      attachments: (extra?.attachments || message.attachments || []).map((a) => ({
        ...a,
        url: '',
        thumbnailUrl: undefined,
      })),
    });
  };

  const openViewOncePhoto = async () => {
    if (viewOnceLoading || !viewOnceCanOpen) return;
    setViewOnceLoading(true);
    let e2eObjectUrl: string | null = null;
    try {
      const res = await chatService.openViewOnce(message.id);
      // Server may return alreadyOpened (idempotent) without media
      if (
        (res as { alreadyOpened?: boolean }).alreadyOpened ||
        !(res.media?.[0]?.url || res.message.attachments?.[0]?.url)
      ) {
        markViewOnceOpenedLocally(res.locked || res.message);
        toast('Photo already opened', { icon: '👁️' });
        return;
      }
      const url =
        res.media?.[0]?.url ||
        res.message.attachments?.[0]?.url ||
        null;
      if (!url) {
        markViewOnceOpenedLocally(res.locked || res.message);
        toast.error('Could not open photo');
        return;
      }

      // E2E view-once: decrypt ciphertext on device before lightbox
      const att0 = res.message.attachments?.[0] || message.attachments?.[0];
      const e2eMeta = att0?.e2eMeta || '';
      let displayUrl = mediaUrl(url) || url;
      if (att0 && (att0.isE2E || isE2EMediaMeta(e2eMeta)) && conversation && userId) {
        const fetchUrl = mediaUrl(url) || url;
        const buf = await fetch(fetchUrl, { credentials: 'include' }).then((r) => {
          if (!r.ok) throw new Error('fetch failed');
          return r.arrayBuffer();
        });
        const dec = await decryptMediaAttachment(conversation, userId, buf, e2eMeta);
        if (!dec) {
          markViewOnceOpenedLocally(res.locked || res.message);
          toast.error('Could not decrypt photo');
          return;
        }
        // Authenticity: only show as view-once photo if decrypted mime is image
        if (!dec.mimeType.startsWith('image/')) {
          markViewOnceOpenedLocally(res.locked || res.message);
          toast.error('Encrypted attachment is not a photo');
          return;
        }
        e2eObjectUrl = URL.createObjectURL(dec.blob);
        displayUrl = e2eObjectUrl;
      }

      setLightbox({
        url: displayUrl,
        viewOnce: true,
        title: 'View once',
      });
      // Never keep unlockable media in the store — only local lightbox state
      const locked = res.locked || res.message;
      markViewOnceOpenedLocally({
        ...locked,
        viewOnceViewedBy: locked.viewOnceViewedBy?.length
          ? locked.viewOnceViewedBy.map(String)
          : [...viewOnceViewedBy, myId],
      });
    } catch (err: unknown) {
      if (e2eObjectUrl) URL.revokeObjectURL(e2eObjectUrl);
      const status =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { status?: number } }).response?.status
          : undefined;
      // Always sync to opened UI if server says it was already consumed
      markViewOnceOpenedLocally();
      toast.error(status === 410 ? 'Photo already opened' : 'Could not open photo');
    } finally {
      setViewOnceLoading(false);
    }
  };

  const closeLightbox = () => {
    const wasViewOnce = lightbox?.viewOnce;
    setLightbox(null);
    // After view-once close, lock the message in the store (no re-view)
    if (wasViewOnce) {
      useChatStore.getState().updateMessage(String(message.conversation), {
        ...message,
        viewOnceOpened: true,
        viewOnceCanOpen: false,
        viewOnceViewedBy: viewOnceViewedBy.includes(String(userId))
          ? viewOnceViewedBy
          : [...viewOnceViewedBy, String(userId || '')].filter(Boolean),
        attachments: (message.attachments || []).map((a) => ({
          ...a,
          url: '',
          thumbnailUrl: undefined,
        })),
      });
    }
  };

  const handleStar = async () => {
    closeMenu();
    try {
      const res = await chatService.star(message.id);
      const convId = String(res.conversationId || message.conversation);
      const store = useChatStore.getState();
      const conv = store.conversations.find((c) => c.id === convId);
      if (conv) {
        store.upsertConversation({
          ...conv,
          hasStarredMessages: !!res.starred,
        });
      }
      toast.success(
        res.starred ? 'Starred — open Favorites in the sidebar' : 'Removed from favorites'
      );
    } catch {
      toast.error('Could not star message');
    }
  };

  return (
    <div
      id={`msg-${message.id}`}
      className={cn(
        // No content-visibility: iOS Safari jumps/blank rows while scrolling long chats
        'group relative flex w-full max-w-full gap-0.5 sm:gap-2',
        isFresh && 'msg-enter',
        isFirstInGroup ? 'mt-2.5' : 'mt-[1px]',
        isLastInGroup ? 'mb-1.5' : 'mb-[1px]',
        isMine ? 'flex-row-reverse' : 'flex-row',
        highlighted &&
          'rounded-2xl bg-pulse-500/10 ring-2 ring-pulse-500/50 shadow-md shadow-pulse-500/15'
      )}
      ref={rootRef}
      onContextMenu={(e) => {
        e.preventDefault();
        if (Date.now() < menuGuardUntil.current) return;
        openMenu();
      }}
      onTouchStart={(e) => {
        // Long-press opens message menu (mobile) — ignore while guard is armed
        if (Date.now() < menuGuardUntil.current) return;
        const t = window.setTimeout(() => {
          if (Date.now() < menuGuardUntil.current) return;
          openMenu();
          // Finger-up after long-press can hit ⋮ — lock it briefly (menu stays open)
          armMenuGuard(400);
        }, 480);
        const clear = () => {
          window.clearTimeout(t);
          e.currentTarget.removeEventListener('touchend', clear);
          e.currentTarget.removeEventListener('touchmove', clear);
          e.currentTarget.removeEventListener('touchcancel', clear);
        };
        e.currentTarget.addEventListener('touchend', clear, { once: true });
        e.currentTarget.addEventListener('touchmove', clear, { once: true });
        e.currentTarget.addEventListener('touchcancel', clear, { once: true });
      }}
    >
      {isGroup && !isMine && showAvatar ? (
        <Avatar src={sender.avatar} name={sender.displayName} size="xs" />
      ) : isGroup && !isMine ? (
        <div className="w-7 shrink-0" />
      ) : null}

      <div
        className={cn(
          // Leave room for the ⋮ actions column; cap width so long lines stay readable
          // while bubbles hug their side of the pane
          'min-w-0 max-w-[min(calc(100%-2.25rem),32rem)] sm:max-w-[min(calc(100%-2.75rem),34rem)]',
          isMine ? 'items-end' : 'items-start'
        )}
      >
        {isGroup && !isMine && showAvatar && (
          <p className="mb-0.5 ml-1 text-[11px] font-medium text-pulse-500">
            {sender.displayName}
          </p>
        )}

        {message.replyTo && typeof message.replyTo === 'object' && (
          <div
            className={cn(
              'msg-reply-preview mb-0.5 border-l-[3px] border-pulse-500 px-3 py-1.5 text-xs',
              isMine ? 'ml-auto' : ''
            )}
          >
            <p className="font-semibold tracking-[-0.01em] text-pulse-500">
              {getSender(message.replyTo as Message).displayName}
            </p>
            <p className="truncate text-[var(--color-ink-secondary)]">
              {isCipherEnvelope((message.replyTo as Message).content)
                ? 'Encrypted message'
                : (message.replyTo as Message).content}
            </p>
          </div>
        )}

        <div
          className={cn(
            'relative px-3.5 py-1.5 transition-shadow duration-200 sm:px-3.5 sm:py-2',
            // Softened corners + tighter stack when grouped
            isMine
              ? cn(
                  'bubble-out bg-pulse-500 text-white',
                  isFirstInGroup && isLastInGroup && 'rounded-[1.2rem] rounded-br-[0.4rem]',
                  isFirstInGroup && !isLastInGroup && 'rounded-[1.2rem] rounded-br-[0.5rem] rounded-tr-[0.75rem]',
                  !isFirstInGroup && isLastInGroup && 'rounded-[1.2rem] rounded-br-[0.4rem] rounded-tr-[0.75rem]',
                  !isFirstInGroup && !isLastInGroup && 'rounded-[0.75rem] rounded-r-[0.75rem]'
                )
              : cn(
                  'bubble-in bg-[var(--color-message-in)] text-[var(--color-ink)]',
                  isFirstInGroup && isLastInGroup && 'rounded-[1.2rem] rounded-bl-[0.4rem]',
                  isFirstInGroup && !isLastInGroup && 'rounded-[1.2rem] rounded-bl-[0.5rem] rounded-tl-[0.75rem]',
                  !isFirstInGroup && isLastInGroup && 'rounded-[1.2rem] rounded-bl-[0.4rem] rounded-tl-[0.75rem]',
                  !isFirstInGroup && !isLastInGroup && 'rounded-[0.75rem] rounded-l-[0.75rem]'
                )
          )}
        >
          {message.forwardedFrom && (
            <p className="msg-forwarded mb-1 flex items-center gap-1 text-[11px] font-medium">
              <Forward className="h-3 w-3" /> Forwarded
            </p>
          )}

          {message.viewOnce && (
            <p
              className={cn(
                'mb-1.5 flex items-center gap-1 text-[11px] font-semibold tracking-[-0.01em]',
                isMine ? 'text-white/80' : 'text-amber-600 dark:text-amber-400'
              )}
            >
              <Timer className="h-3 w-3" />
              {viewOnceShowOpened
                ? 'Opened'
                : isMine
                  ? 'View once'
                  : 'View once photo'}
            </p>
          )}

          {/* View-once recipients: single placeholder (don't depend on attachment count) */}
          {message.viewOnce && !isMine && (
            viewOnceShowOpened || !viewOnceCanOpen ? (
              <div className="mb-2 flex min-h-[7.5rem] w-[min(70vw,14rem)] flex-col items-center justify-center gap-2 rounded-xl bg-black/[0.06] px-4 py-6 dark:bg-white/[0.06]">
                <EyeOff className="h-7 w-7 opacity-50" />
                <span className="text-xs font-medium opacity-70">Photo opened</span>
              </div>
            ) : (
              <button
                type="button"
                disabled={viewOnceLoading}
                onClick={() => void openViewOncePhoto()}
                className={cn(
                  'view-once-card mb-2 flex min-h-[7.5rem] w-[min(70vw,14rem)] flex-col items-center justify-center gap-2 rounded-xl px-4 py-6',
                  'bg-gradient-to-br from-amber-500/20 to-orange-500/10 ring-1 ring-amber-500/25'
                )}
              >
                {viewOnceLoading ? (
                  <Loader2 className="h-7 w-7 animate-spin text-amber-600 dark:text-amber-400" />
                ) : (
                  <Eye className="h-7 w-7 text-amber-600 dark:text-amber-400" />
                )}
                <span className="text-sm font-semibold tracking-[-0.01em]">
                  {viewOnceLoading ? 'Opening…' : 'View photo'}
                </span>
                <span className="text-[11px] opacity-60">Tap to open once</span>
              </button>
            )
          )}

          {/* Pulse Play game card (server-authoritative) */}
          {isGame && gameId && <GameCard gameId={String(gameId)} />}

          {/* Attachments (skip raw images for recipient view-once — use placeholder above) */}
          {!(message.viewOnce && !isMine) &&
            !isGame &&
            message.attachments?.map((att, i) => {
            // E2E: decrypt on device only — server has ciphertext
            if (isE2EAttachment(att)) {
              return (
                <E2EMediaAttachment
                  key={att.id || i}
                  attachment={att}
                  conversation={conversation}
                  myId={userId || ''}
                  isMine={isMine}
                  messageType={message.type}
                  onOpenImage={(url, name) => openNormalPhoto(url, name || att.originalName)}
                />
              );
            }
            const src = mediaUrl(att.url) || att.url;
            if (!src && att.mimeType?.startsWith('image/')) {
              return null;
            }
            if (att.mimeType?.startsWith('image/')) {
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => openNormalPhoto(src!, att.originalName)}
                  className="media-skeleton mb-1.5 block max-w-full overflow-hidden rounded-xl text-left ring-1 ring-black/5 dark:ring-white/10"
                  aria-label={`Open photo ${att.originalName || ''}`.trim()}
                >
                  <img
                    src={src}
                    alt={att.originalName}
                    className="media-img media-img-ready max-h-72 max-w-full rounded-xl object-cover"
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                  />
                </button>
              );
            }
            if (att.mimeType?.startsWith('video/')) {
              return (
                <div
                  key={i}
                  className="mb-1.5 overflow-hidden rounded-xl ring-1 ring-black/10 dark:ring-white/10"
                >
                  <video
                    src={src}
                    controls
                    playsInline
                    preload="metadata"
                    className="max-h-72 max-w-full bg-black"
                  />
                </div>
              );
            }
            if (att.mimeType?.startsWith('audio/') || message.type === 'voice') {
              return (
                <div
                  key={i}
                  className={cn(
                    'mb-1.5 min-w-[12rem] rounded-2xl px-2.5 py-2',
                    isMine ? 'bg-white/15' : 'bg-black/[0.06] dark:bg-white/[0.06]'
                  )}
                >
                  <audio src={src} controls preload="metadata" className="w-full max-w-[16rem]" />
                </div>
              );
            }
            return (
              <a
                key={i}
                href={src}
                download={att.originalName}
                className={cn(
                  'mb-1.5 flex min-h-11 items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm transition-colors',
                  isMine
                    ? 'bg-white/15 hover:bg-white/20'
                    : 'bg-black/5 hover:bg-black/[0.07] dark:bg-white/5 dark:hover:bg-white/[0.08]'
                )}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-black/10 text-base dark:bg-white/10">
                  📄
                </span>
                <div className="min-w-0">
                  <p className="truncate font-medium tracking-[-0.01em]">{att.originalName}</p>
                  <p className="text-[11px] opacity-65">{formatFileSize(att.size)}</p>
                </div>
              </a>
            );
          })}

          {(message.content || cipherPending) && (
            <div className="msg-md text-[15px] leading-[1.42] tracking-[-0.012em] break-words sm:text-[14.5px]">
              {cipherPending ? (
                // Soft placeholder — never show 🔐e2e:… base64 in the bubble
                <p className="flex items-center gap-2 text-[13px] opacity-55" aria-label="Decrypting">
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  <span className="inline-block h-2.5 w-24 max-w-[40%] rounded-full bg-current opacity-25" />
                </p>
              ) : plainContent !== null ? (
                // Fast path: plain text (no remark/unified parse — most messages)
                <p className="whitespace-pre-wrap">{plainContent}</p>
              ) : (
                <Suspense
                  fallback={
                    <p className="flex items-center gap-2 opacity-50">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    </p>
                  }
                >
                  <MarkdownBody content={message.content || ''} />
                </Suspense>
              )}
            </div>
          )}

          {message.linkPreview &&
            /^https?:\/\//i.test(message.linkPreview.url || '') && (
            <a
              href={message.linkPreview.url}
              target="_blank"
              rel="noopener noreferrer nofollow ugc"
              className={cn(
                'mt-2 block overflow-hidden rounded-xl border text-xs',
                isMine ? 'border-white/20' : 'border-[var(--color-border)]'
              )}
            >
              {message.linkPreview.image &&
                /^https:\/\//i.test(message.linkPreview.image) && (
                <img
                  src={message.linkPreview.image}
                  alt=""
                  className="h-28 w-full object-cover"
                  referrerPolicy="no-referrer"
                />
              )}
              <div className="p-2">
                <p className="font-semibold">{message.linkPreview.title}</p>
                <p className="opacity-70 truncate">{message.linkPreview.url}</p>
              </div>
            </a>
          )}

          <div
            className={cn(
              'msg-timestamp mt-0.5 flex items-center justify-end gap-1',
              isLastInGroup || message.isEdited || message.isPinned
                ? 'text-[10px]'
                : 'text-[9px]',
              isMine ? 'text-white/50' : 'text-[var(--color-ink-secondary)]/60',
              // Hide time on tight middle-of-group bubbles (keep ticks/edited)
              !isLastInGroup && !message.isEdited && !message.isPinned && !isMine && 'sr-only'
            )}
          >
            {message.isPinned && <Pin className="h-3 w-3 opacity-80" />}
            {message.isEdited && <span className="opacity-80">edited</span>}
            {(isLastInGroup || compactTime || isMine) && (
              <span className={cn(!isLastInGroup && 'opacity-70')}>
                {formatMessageTime(message.createdAt)}
              </span>
            )}
            {isMine &&
              (read ? (
                <CheckCheck className="h-3.5 w-3.5 text-sky-200/90" />
              ) : delivered ? (
                <CheckCheck className="h-3.5 w-3.5 opacity-80" />
              ) : (
                <Check className="h-3.5 w-3.5 opacity-80" />
              ))}
          </div>
        </div>

        {/* Reactions */}
        {message.reactions?.length > 0 && (
          <div className={cn('mt-1 flex flex-wrap gap-1', isMine && 'justify-end')}>
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => handleReact(r.emoji)}
                className="reaction-chip reaction-enter rounded-full border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-2 py-0.5 text-xs shadow-sm"
              >
                {r.emoji}{' '}
                <span className="tabular-nums text-[var(--color-ink-secondary)]">
                  {r.users?.length || 0}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Actions: always visible on touch; hover on desktop */}
      <div
        className={cn(
          'flex shrink-0 items-center gap-0.5 self-center transition-opacity',
          'opacity-100 md:opacity-0 md:group-hover:opacity-100',
          menu || showReact ? 'opacity-100 md:opacity-100' : ''
        )}
      >
        <button
          type="button"
          className="hidden min-h-9 min-w-9 items-center justify-center rounded-full p-1.5 hover:bg-black/5 dark:hover:bg-white/10 sm:inline-flex"
          onClick={() => {
            setMenu(false);
            setShowReact((v) => !v);
          }}
          aria-label="React"
        >
          <Smile className="h-4 w-4 text-[var(--color-ink-secondary)]" />
        </button>
        <button
          type="button"
          className="hidden min-h-9 min-w-9 items-center justify-center rounded-full p-1.5 hover:bg-black/5 dark:hover:bg-white/10 sm:inline-flex"
          onClick={() => setReplyTo(message)}
          aria-label="Reply"
        >
          <Reply className="h-4 w-4 text-[var(--color-ink-secondary)]" />
        </button>
        <button
          ref={menuBtnRef}
          type="button"
          disabled={menuBtnLocked}
          className={cn(
            'inline-flex min-h-9 min-w-9 items-center justify-center rounded-full p-1.5 active:bg-black/10 hover:bg-black/5 dark:hover:bg-white/10',
            menuBtnLocked && 'pointer-events-none opacity-50'
          )}
          onPointerDown={(e) => {
            // Block ghost clicks from a just-closed sheet (fires before click)
            if (Date.now() < menuGuardUntil.current || menuBtnLocked) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (Date.now() < menuGuardUntil.current || menuBtnLocked) return;
            toggleMenu();
          }}
          aria-label="Message options"
          aria-expanded={menu}
          aria-haspopup="menu"
        >
          <MoreHorizontal className="h-4 w-4 text-[var(--color-ink-secondary)]" />
        </button>
      </div>

      {/* Desktop dropdown — portaled + fixed so chat scroller never clips it */}
      {menu &&
        menuPos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={desktopMenuRef}
            role="menu"
            className="popover-enter fixed z-[220] hidden max-h-[min(70vh,22rem)] w-52 overflow-y-auto overscroll-contain rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)] py-1.5 shadow-[0_16px_48px_rgba(0,0,0,0.16)] sm:block scrollbar-thin"
            style={{
              top: menuPos.openUp ? undefined : menuPos.top,
              bottom: menuPos.openUp
                ? window.innerHeight - menuPos.top
                : undefined,
              left: menuPos.left,
              transformOrigin: menuPos.openUp ? 'bottom right' : 'top right',
            }}
          >
            <MessageMenuItems
              isMine={isMine}
              isPinned={!!message.isPinned}
              onEdit={() => {
                closeMenu();
                setEditingMessage(message);
              }}
              onCopy={() => {
                closeMenu();
                void navigator.clipboard.writeText(message.content || '');
                toast.success('Copied');
              }}
              onReply={() => {
                closeMenu();
                setReplyTo(message);
              }}
              onReact={() => {
                // Close options, then open react (guard blocks ⋮ ghost re-open)
                armMenuGuard(500);
                setMenu(false);
                window.setTimeout(() => {
                  if (Date.now() < menuGuardUntil.current - 200) {
                    /* still in guard from arm — open react anyway */
                  }
                  setShowReact(true);
                }, 60);
              }}
              onPin={handlePin}
              onStar={handleStar}
              onDeleteMe={handleDeleteMe}
              onDeleteEveryone={handleDeleteEveryone}
            />
          </div>,
          document.body
        )}

      {/* Desktop reactions — portaled */}
      {showReact &&
        reactPos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={desktopReactRef}
            className="popover-enter fixed z-[220] hidden items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-2 py-1.5 shadow-xl sm:flex"
            style={{
              top: reactPos.openUp ? undefined : reactPos.top,
              bottom: reactPos.openUp
                ? window.innerHeight - reactPos.top
                : undefined,
              left: reactPos.left,
              width: REACT_WIDTH,
              justifyContent: 'space-around',
            }}
          >
            {QUICK_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                className="flex h-9 w-9 items-center justify-center text-lg transition-transform hover:scale-125"
                onClick={() => void handleReact(e)}
              >
                {e}
              </button>
            ))}
          </div>,
          document.body
        )}

      {/* Mobile action sheet — portaled so chat scroller never clips it */}
      {menu &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] sm:hidden"
            role="dialog"
            aria-modal="true"
            // Capture taps so they never fall through to chat after unmount
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="absolute inset-0 animate-fade-in bg-black/45 backdrop-blur-[2px]"
              aria-label="Close menu"
              onPointerDown={(e) => {
                // Close on pointerdown so click never hits content underneath
                e.preventDefault();
                e.stopPropagation();
                closeMenu();
              }}
            />
            <div
              ref={sheetRef}
              className="sheet-enter absolute inset-x-0 bottom-0 flex max-h-[min(85dvh,var(--app-height,100dvh))] flex-col rounded-t-[1.35rem] border border-[var(--color-border)] bg-[var(--color-surface-elevated)] shadow-2xl"
              style={{
                paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))',
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="relative flex shrink-0 items-center justify-center px-4 pb-1 pt-3">
                <div className="h-1 w-10 rounded-full bg-black/15 dark:bg-white/20" />
                <button
                  type="button"
                  className="absolute right-3 top-2.5 z-10 flex h-10 w-10 items-center justify-center rounded-full active:bg-black/5"
                  aria-label="Close"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    closeMenu();
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    closeMenu();
                  }}
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <p className="shrink-0 px-5 pb-2 text-center text-sm font-semibold tracking-[-0.02em]">
                Message options
              </p>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
                <MessageMenuItems
                  isMine={isMine}
                  isPinned={!!message.isPinned}
                  dense={false}
                  onEdit={() => {
                    closeMenu();
                    setEditingMessage(message);
                  }}
                  onCopy={() => {
                    closeMenu();
                    void navigator.clipboard.writeText(message.content || '');
                    toast.success('Copied');
                  }}
                  onReply={() => {
                    closeMenu();
                    setReplyTo(message);
                  }}
                  onReact={() => {
                    // Close options sheet, open emoji sheet after paint
                    armMenuGuard(500);
                    setMenu(false);
                    window.setTimeout(() => setShowReact(true), 60);
                  }}
                  onPin={handlePin}
                  onStar={handleStar}
                  onDeleteMe={handleDeleteMe}
                  onDeleteEveryone={handleDeleteEveryone}
                />
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* In-app photo lightbox (normal + view-once) */}
      {lightbox &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="lightbox-backdrop fixed inset-0 z-[300] flex flex-col bg-black/88 animate-fade-in"
            role="dialog"
            aria-modal="true"
            aria-label={lightbox.viewOnce ? 'View once photo' : 'Photo'}
            onClick={closeLightbox}
          >
            <div
              className="flex items-center justify-between px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))] text-white"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                {lightbox.viewOnce ? (
                  <>
                    <Timer className="h-4 w-4 shrink-0 text-amber-400" />
                    View once
                  </>
                ) : (
                  <span className="truncate">{lightbox.title}</span>
                )}
              </span>
              <button
                type="button"
                className="pressable flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10"
                aria-label="Close"
                onClick={closeLightbox}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div
              className="flex min-h-0 flex-1 items-center justify-center p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={lightbox.url}
                alt={lightbox.title}
                className="lightbox-img max-h-full max-w-full object-contain"
                draggable={false}
                onContextMenu={
                  lightbox.viewOnce ? (e) => e.preventDefault() : undefined
                }
              />
            </div>
            <p className="pb-[max(1rem,env(safe-area-inset-bottom))] text-center text-xs text-white/50">
              {lightbox.viewOnce
                ? 'This photo will disappear when you close it'
                : 'Tap outside or press × to close'}
            </p>
          </div>,
          document.body
        )}

      {/* Mobile reactions — portaled bottom bar */}
      {showReact &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] sm:hidden"
            role="dialog"
            aria-modal="true"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="absolute inset-0 animate-fade-in bg-black/40 backdrop-blur-[2px]"
              aria-label="Close reactions"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                closeMenu();
              }}
            />
            <div
              ref={sheetRef}
              className="sheet-enter absolute inset-x-0 bottom-0 rounded-t-[1.35rem] border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-4 pt-3 shadow-2xl"
              style={{
                paddingBottom: 'max(1rem, env(safe-area-inset-bottom, 0px))',
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-black/15 dark:bg-white/20" />
              <p className="mb-3 text-center text-sm font-semibold tracking-[-0.02em]">React</p>
              <div className="flex justify-around gap-1 pb-2">
                {QUICK_EMOJIS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    className="pressable flex h-12 w-12 items-center justify-center rounded-2xl text-2xl transition-transform duration-150 active:scale-110 active:bg-black/5"
                    onClick={() => handleReact(e)}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleInner, (prev, next) => {
  return (
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.isDeleted === next.message.isDeleted &&
    prev.message.isEdited === next.message.isEdited &&
    prev.message.isPinned === next.message.isPinned &&
    prev.message.viewOnce === next.message.viewOnce &&
    prev.message.viewOnceOpened === next.message.viewOnceOpened &&
    prev.message.viewOnceCanOpen === next.message.viewOnceCanOpen &&
    prev.message.viewOnceViewedBy === next.message.viewOnceViewedBy &&
    prev.message.attachments === next.message.attachments &&
    prev.message.reactions === next.message.reactions &&
    prev.message.readBy === next.message.readBy &&
    prev.message.deliveredTo === next.message.deliveredTo &&
    prev.showAvatar === next.showAvatar &&
    prev.isGroup === next.isGroup &&
    prev.highlighted === next.highlighted &&
    prev.isFirstInGroup === next.isFirstInGroup &&
    prev.isLastInGroup === next.isLastInGroup &&
    prev.compactTime === next.compactTime
  );
});
