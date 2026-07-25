import { useEffect, useRef } from 'react';
import { connectSocket, pauseSocket, resumeSocket } from '../services/socket';
import { useChatStore } from '../store/chatStore';
import { useCallStore } from '../store/callStore';
import { useAuthStore } from '../store/authStore';
import type { Message, Conversation } from '../types';
import toast from 'react-hot-toast';

/** True on iPhone / iPad Safari (including desktop-mode iPad). */
function isAppleMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/**
 * One shared AudioContext for notification blips.
 *
 * Creating a context per notification leaked them whenever `onended` did not
 * fire (suspended context under autoplay policy). Browsers cap concurrent
 * AudioContexts at ~6, after which construction throws and notification sounds
 * silently stop working for the rest of the session.
 */
let notifyCtx: AudioContext | null = null;

function getNotifyContext(): AudioContext | null {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    if (!notifyCtx || notifyCtx.state === 'closed') {
      notifyCtx = new Ctx();
    }
    if (notifyCtx.state === 'suspended') {
      void notifyCtx.resume().catch(() => undefined);
    }
    return notifyCtx;
  } catch {
    return null;
  }
}

function playNotificationSound() {
  try {
    const ctx = getNotifyContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    osc.stop(ctx.currentTime + 0.3);
    // Release only the nodes; the context is shared and stays open
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        /* */
      }
    };
  } catch {
    /* ignore autoplay policy */
  }
}

async function showBrowserNotification(title: string, body: string) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {
      return;
    }
  }
  if (Notification.permission === 'granted' && document.hidden) {
    try {
      new Notification(title, { body, icon: '/favicon.svg' });
    } catch {
      /* */
    }
  }
}

function conversationIdOf(message: Message): string {
  const c = message.conversation as unknown;
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object') {
    const o = c as { id?: string; _id?: string; toString?: () => string };
    return o.id || o._id || o.toString?.() || String(c);
  }
  return String(c ?? '');
}

function senderIdOf(message: Message): string {
  if (typeof message.sender === 'string') return message.sender;
  const s = message.sender as { id?: string; _id?: string };
  return s?.id || s?._id || '';
}

export function useSocketEvents() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const userId = useAuthStore((s) => s.user?.id);
  const boundRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || !userId) return;

    const socket = connectSocket();
    boundRef.current = true;
    const appleMobile = isAppleMobileBrowser();
    let hidePauseTimer: ReturnType<typeof setTimeout> | null = null;

    // Heartbeat so server can detect frozen/background tabs.
    // Skip while hidden unless a call is active (media keeps the socket; sweeper still needs HB).
    const heartbeat = window.setInterval(() => {
      const inCall = (() => {
        try {
          return !!useCallStore.getState().active;
        } catch {
          return false;
        }
      })();
      if (document.hidden && !inCall) return;
      const s = resumeSocket() || socket;
      if (s?.connected) {
        s.emit('presence:ping');
      }
    }, 25_000);

    /**
     * Resume after background / bfcache restore.
     * Never force a full page reload — just reattach the socket.
     */
    const resumeRealtime = () => {
      try {
        if (hidePauseTimer) {
          clearTimeout(hidePauseTimer);
          hidePauseTimer = null;
        }
        const s = resumeSocket() || socket;
        if (s?.connected) {
          s.emit('presence:ping');
        }
      } catch {
        /* */
      }
    };

    /**
     * Close the WebSocket so the page can enter bfcache.
     * Leaving it open is the #1 reason iOS Safari kills Pulse on app-switch
     * and cold-reloads the entire SPA when you come back.
     *
     * Do NOT use beforeunload (also disables bfcache).
     * Do NOT emit presence:leave — server uses disconnect + grace period.
     */
    const pauseForBackground = () => {
      // Keep media path alive during an active call — dropping WS mid-call is worse
      // than a possible reload after the call ends.
      try {
        if (useCallStore.getState().active) return;
      } catch {
        /* */
      }
      pauseSocket();
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        resumeRealtime();
        return;
      }
      // Hidden: delay pause so Control Center / app switcher flickers don't thrash.
      // pagehide still pauses immediately for true freezes.
      if (hidePauseTimer) clearTimeout(hidePauseTimer);
      hidePauseTimer = setTimeout(
        () => {
          hidePauseTimer = null;
          if (document.visibilityState === 'hidden') {
            pauseForBackground();
          }
        },
        appleMobile ? 1200 : 4000
      );
    };
    document.addEventListener('visibilitychange', onVisibility);

    // pageshow: bfcache restore (persisted) OR normal show after navigation
    const onPageShow = (_e: PageTransitionEvent) => {
      resumeRealtime();
    };
    window.addEventListener('pageshow', onPageShow);

    // pagehide: entering freeze / unload — close WS so Safari can bfcache
    const onPageHide = (_e: PageTransitionEvent) => {
      if (hidePauseTimer) {
        clearTimeout(hidePauseTimer);
        hidePauseTimer = null;
      }
      pauseForBackground();
    };
    window.addEventListener('pagehide', onPageHide);

    // freeze/resume (modern browsers) — same idea as pagehide/pageshow
    const onFreeze = () => pauseForBackground();
    const onResume = () => resumeRealtime();
    document.addEventListener('freeze', onFreeze);
    document.addEventListener('resume', onResume);

    const onMessage = (message: Message) => {
      const store = useChatStore.getState();
      const convId = conversationIdOf(message);
      if (!convId) return;

      // Chat may have been "deleted for me" and re-surfaced by a new message
      const ensureConvThen = (run: () => void) => {
        if (store.conversations.some((c) => c.id === convId)) {
          run();
          return;
        }
        void import('../services/chat.service')
          .then(({ chatService }) => chatService.getConversation(convId))
          .then((conv) => {
            useChatStore.getState().upsertConversation(conv);
            run();
          })
          .catch(() => {
            // Still apply message so UI can recover on next list refresh
            run();
          });
      };

      ensureConvThen(() => {
        void (async () => {
          const s = useChatStore.getState();
          let msg = message;
          // Decrypt on-device before store / notifications
          try {
            const {
              decryptMessageContent,
              isE2ECiphertext,
              ensureConversationE2E,
            } = await import('../services/e2e');
            let conv = s.conversations.find((c) => c.id === convId);

            // For ciphertext: use store conversation; only fetch if wraps missing
            if (userId && msg.content && isE2ECiphertext(msg.content)) {
              if (!conv?.e2eWrappedKeys?.length || !conv.participants?.length) {
                try {
                  const { chatService } = await import('../services/chat.service');
                  const full = await chatService.getConversation(convId);
                  useChatStore.getState().upsertConversation(full);
                  conv = full;
                } catch {
                  /* use list row */
                }
              }
              if (conv) {
                try {
                  const ensured = await ensureConversationE2E(conv, userId);
                  if (ensured) {
                    useChatStore.getState().upsertConversation(ensured);
                    conv = ensured;
                  }
                } catch {
                  /* */
                }
              }
            }

            if (userId && conv && isE2ECiphertext(msg.content)) {
              const plain = await decryptMessageContent(
                conv,
                userId,
                msg.content || '',
                msg.isE2E
              );
              msg = { ...msg, content: plain };
            } else if (msg.isE2E && !isE2ECiphertext(msg.content)) {
              msg = { ...msg, isE2E: false };
            }
          } catch {
            if (msg.content?.startsWith('🔐e2e:')) {
              msg = { ...msg, content: '🔒 Encrypted message' };
            }
          }

          s.addMessage(convId, msg);
          const senderId = senderIdOf(msg);

          if (senderId && senderId !== userId) {
            if (s.activeConversationId === convId && !document.hidden) {
              s.clearUnread(convId);
              socket.emit('message:read', {
                conversationId: convId,
                messageId: msg.id,
              });
            } else {
              s.incrementUnread(convId);
              const settings = useAuthStore.getState().user?.settings?.notifications;
              if (settings?.sound !== false) playNotificationSound();
              if (settings?.browser !== false && settings?.messages !== false) {
                const name =
                  typeof msg.sender === 'object'
                    ? (msg.sender as { displayName?: string }).displayName
                    : 'New message';
                const body =
                  msg.content?.startsWith('🔒') || msg.content?.startsWith('🔐e2e:')
                    ? '🔒 Encrypted message'
                    : msg.content || 'New message';
                void showBrowserNotification(name || 'Pulse', body);
              }
            }
            socket.emit('message:delivered', {
              messageId: msg.id,
              conversationId: convId,
            });
          }
        })();
      });
    };

    const onUpdated = (message: Message) => {
      const convId = conversationIdOf(message);
      if (!convId) return;
      void (async () => {
        let msg = message;
        try {
          const { decryptMessageContent, isE2ECiphertext, preferReadableContent } =
            await import('../services/e2e');
          const conv = useChatStore.getState().conversations.find((c) => c.id === convId);
          if (userId && conv && isE2ECiphertext(msg.content)) {
            msg = {
              ...msg,
              content: await decryptMessageContent(conv, userId, msg.content || '', msg.isE2E),
            };
          }
          // Preserve already-readable content in the store
          const existing = useChatStore
            .getState()
            .messages[convId]?.find((m) => m.id === msg.id);
          if (existing?.content) {
            msg = {
              ...msg,
              content: preferReadableContent(existing.content, msg.content),
            };
          }
        } catch {
          /* keep as-is */
        }
        useChatStore.getState().updateMessage(convId, msg);
      })();
    };

    const onDeleted = (message: Message) => {
      const convId = conversationIdOf(message);
      if (convId) useChatStore.getState().updateMessage(convId, message);
    };

    // Reactions: only patch reaction metadata — full message payload is often ciphertext
    const onReaction = (message: Message) => {
      const convId = conversationIdOf(message);
      if (!convId || !message?.id) return;
      useChatStore.getState().updateMessage(convId, {
        id: message.id,
        reactions: message.reactions || [],
      } as Message);
    };

    const onConvNew = (conversation: Conversation) => {
      void import('../utils/decryptConversationList').then(({ decryptAndUpsertConversation }) =>
        decryptAndUpsertConversation(conversation)
      );
    };

    const onConvUpdated = (conversation: Conversation) => {
      void import('../utils/decryptConversationList').then(({ decryptAndUpsertConversation }) =>
        decryptAndUpsertConversation(conversation)
      );
    };

    const onConvRemoved = ({ conversationId }: { conversationId: string }) => {
      useChatStore.getState().removeConversation(conversationId);
    };

    const onTypingStart = ({
      conversationId,
      userId: typingUserId,
    }: {
      conversationId: string;
      userId: string;
    }) => {
      if (typingUserId !== userId) {
        useChatStore.getState().setTyping(conversationId, typingUserId, true);
      }
    };

    const onTypingStop = ({
      conversationId,
      userId: typingUserId,
    }: {
      conversationId: string;
      userId: string;
    }) => {
      useChatStore.getState().setTyping(conversationId, typingUserId, false);
    };

    const onOnline = ({
      userId: uid,
      lastSeen,
    }: {
      userId: string;
      lastSeen?: string;
    }) => {
      useChatStore.getState().setUserOnline(uid, true, lastSeen);
    };

    const onOffline = ({
      userId: uid,
      lastSeen,
    }: {
      userId: string;
      lastSeen?: string | Date;
    }) => {
      useChatStore.getState().setUserOnline(uid, false, lastSeen);
    };

    const onMessagesRead = ({
      conversationId,
      userId: readerId,
    }: {
      conversationId: string;
      userId: string;
    }) => {
      // Store-level patch: skip rewrite when nothing changed
      if (!userId) return;
      useChatStore.getState().markMessagesReadBy(conversationId, readerId, userId);
    };

    const onCallIncoming = (payload: {
      callId: string;
      fromUserId: string;
      conversationId: string;
      callType: 'audio' | 'video' | 'screen';
      sdpOffer?: RTCSessionDescriptionInit;
      group?: boolean;
      initiatorId?: string;
      members?: { userId: string; status: 'invited' | 'joined' | 'left' | 'rejected' }[];
    }) => {
      if (import.meta.env.DEV) console.debug('[call] incoming', payload);
      if (!payload?.fromUserId) {
        console.warn('[call] incomplete incoming payload', payload);
        return;
      }
      useCallStore.getState().handleIncoming(payload);
      playNotificationSound();
      toast(payload.group ? 'Incoming group call…' : 'Incoming call…', {
        icon: '📞',
        id: `call-${payload.callId}`,
      });
    };

    const onGroupIncoming = (payload: {
      callId: string;
      conversationId: string;
      callType: 'audio' | 'video' | 'screen';
      initiatorId?: string;
      fromUserId?: string;
      invitedBy?: string;
      members?: { userId: string; status: 'invited' | 'joined' | 'left' | 'rejected' }[];
      group?: boolean;
    }) => {
      if (import.meta.env.DEV) console.debug('[call] group incoming', payload);
      const from = String(payload.fromUserId || payload.initiatorId || payload.invitedBy || '');
      if (!from || !payload.callId) {
        console.warn('[call] incomplete group incoming', payload);
        return;
      }
      useCallStore.getState().handleIncoming({
        callId: payload.callId,
        fromUserId: from,
        conversationId: payload.conversationId,
        callType: payload.callType || 'audio',
        group: true,
        initiatorId: payload.initiatorId || from,
        members: payload.members,
      });
      playNotificationSound();
      toast('Incoming group call…', { icon: '📞', id: `call-${payload.callId}` });
    };

    const onCallAnswer = (payload: {
      sdpAnswer?: RTCSessionDescriptionInit;
      fromUserId?: string;
      callId?: string;
    }) => {
      if (import.meta.env.DEV) console.debug('[call] answer / accepted', payload?.fromUserId);
      // Always notify — socket audio relay starts on accept even without real SDP
      void useCallStore.getState().handleAnswer(payload?.sdpAnswer || { type: 'answer', sdp: '' });
    };

    const onIce = (payload: { candidate?: RTCIceCandidateInit; fromUserId?: string }) => {
      if (payload?.candidate) {
        void useCallStore.getState().handleIce(payload.candidate);
      }
    };

    const onCallMedia = (payload: {
      data?: ArrayBuffer | ArrayBufferView | Blob | number[] | string;
      dataB64?: string;
      format?: string;
      sampleRate?: number;
      mimeType?: string;
      width?: number;
      height?: number;
      fromUserId?: string;
      callId?: string;
      group?: boolean;
    }) => {
      useCallStore.getState().handleMedia?.(payload);
    };

    /** Dismiss only this call's toast — a bare toast.dismiss() clears unrelated ones. */
    const dismissCallToast = (callId?: string) => {
      const id = callId || useCallStore.getState().callId;
      if (id) toast.dismiss(`call-${id}`);
    };

    // Remote hung up / rejected — do not notify them back
    const onCallEnded = (payload?: { callId?: string }) => {
      if (import.meta.env.DEV) console.debug('[call] ended by remote');
      // 1:1 only — group uses call:group:ended / peer-left
      if (useCallStore.getState().isGroup) return;
      dismissCallToast(payload?.callId);
      useCallStore.getState().endCall(false);
    };

    const onCallRejected = () => {
      if (import.meta.env.DEV) console.debug('[call] rejected by remote');
      if (useCallStore.getState().isGroup) {
        // One peer declined — keep the room open
        return;
      }
      useCallStore.getState().endCall(false);
      toast.error('Call declined');
    };

    const onGroupRoster = (payload: {
      callId?: string;
      members?: { userId: string; status: 'invited' | 'joined' | 'left' | 'rejected' }[];
      initiatorId?: string;
      callType?: 'audio' | 'video' | 'screen';
    }) => {
      useCallStore.getState().handleGroupRoster(payload);
    };

    const onGroupPeerJoined = (payload: {
      callId?: string;
      userId?: string;
      members?: { userId: string; status: 'invited' | 'joined' | 'left' | 'rejected' }[];
    }) => {
      useCallStore.getState().handleGroupPeerJoined(payload);
      // Host: first peer joining marks connected
      if (useCallStore.getState().status === 'connecting') {
        void useCallStore.getState().handleAnswer({ type: 'answer', sdp: '' });
      }
    };

    const onGroupPeerLeft = (payload: {
      callId?: string;
      userId?: string;
      members?: { userId: string; status: 'invited' | 'joined' | 'left' | 'rejected' }[];
    }) => {
      useCallStore.getState().handleGroupPeerLeft(payload);
    };

    const onGroupPeerRejected = (payload: {
      callId?: string;
      userId?: string;
      members?: { userId: string; status: 'invited' | 'joined' | 'left' | 'rejected' }[];
    }) => {
      useCallStore.getState().handleGroupPeerRejected(payload);
      toast('Someone declined the group call', { icon: '📵', duration: 2500 });
    };

    const onGroupEnded = (payload?: { callId?: string }) => {
      dismissCallToast(payload?.callId);
      useCallStore.getState().handleGroupEnded(payload);
    };

    const onCallError = (payload?: { message?: string }) => {
      const msg = payload?.message || 'Call error';
      console.warn('[call] error', msg);
      toast.error(msg);
    };

    const onGameEvent = (payload: { game?: { id?: string } }) => {
      if (payload?.game?.id) {
        window.dispatchEvent(
          new CustomEvent('pulse:game-updated', { detail: payload.game })
        );
      }
    };

    const onPollUpdated = (payload: { poll?: { id?: string } }) => {
      if (payload?.poll?.id) {
        window.dispatchEvent(
          new CustomEvent('pulse:poll-updated', { detail: payload.poll })
        );
      }
    };

    socket.on('message:new', onMessage);
    socket.on('message:updated', onUpdated);
    socket.on('message:deleted', onDeleted);
    socket.on('message:reaction', onReaction);
    socket.on('message:pinned', onUpdated);
    socket.on('messages:read', onMessagesRead);
    socket.on('conversation:new', onConvNew);
    socket.on('conversation:updated', onConvUpdated);
    socket.on('conversation:removed', onConvRemoved);
    socket.on('conversation:deleted', onConvRemoved);
    socket.on('typing:start', onTypingStart);
    socket.on('typing:stop', onTypingStop);
    socket.on('user:online', onOnline);
    socket.on('user:offline', onOffline);
    socket.on('call:incoming', onCallIncoming);
    socket.on('call:group:incoming', onGroupIncoming);
    socket.on('call:answer', onCallAnswer);
    socket.on('call:accepted', onCallAnswer);
    socket.on('call:ice-candidate', onIce);
    socket.on('call:media', onCallMedia);
    socket.on('call:ended', onCallEnded);
    socket.on('call:rejected', onCallRejected);
    socket.on('call:group:roster', onGroupRoster);
    socket.on('call:group:peer-joined', onGroupPeerJoined);
    socket.on('call:group:peer-left', onGroupPeerLeft);
    socket.on('call:group:peer-rejected', onGroupPeerRejected);
    socket.on('call:group:ended', onGroupEnded);
    socket.on('call:group:joined', onGroupRoster);
    socket.on('call:error', onCallError);
    socket.on('game:created', onGameEvent);
    socket.on('game:updated', onGameEvent);
    socket.on('game:started', onGameEvent);
    socket.on('game:completed', onGameEvent);
    socket.on('game:expired', onGameEvent);
    socket.on('poll:updated', onPollUpdated);

    return () => {
      boundRef.current = false;
      window.clearInterval(heartbeat);
      if (hidePauseTimer) clearTimeout(hidePauseTimer);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('freeze', onFreeze);
      document.removeEventListener('resume', onResume);
      socket.off('message:new', onMessage);
      socket.off('message:updated', onUpdated);
      socket.off('message:deleted', onDeleted);
      socket.off('message:reaction', onReaction);
      socket.off('message:pinned', onUpdated);
      socket.off('messages:read', onMessagesRead);
      socket.off('conversation:new', onConvNew);
      socket.off('conversation:updated', onConvUpdated);
      socket.off('conversation:removed', onConvRemoved);
      socket.off('conversation:deleted', onConvRemoved);
      socket.off('typing:start', onTypingStart);
      socket.off('typing:stop', onTypingStop);
      socket.off('user:online', onOnline);
      socket.off('user:offline', onOffline);
      socket.off('call:incoming', onCallIncoming);
      socket.off('call:group:incoming', onGroupIncoming);
      socket.off('call:answer', onCallAnswer);
      socket.off('call:accepted', onCallAnswer);
      socket.off('call:ice-candidate', onIce);
      socket.off('call:media', onCallMedia);
      socket.off('call:ended', onCallEnded);
      socket.off('call:rejected', onCallRejected);
      socket.off('call:group:roster', onGroupRoster);
      socket.off('call:group:peer-joined', onGroupPeerJoined);
      socket.off('call:group:peer-left', onGroupPeerLeft);
      socket.off('call:group:peer-rejected', onGroupPeerRejected);
      socket.off('game:created', onGameEvent);
      socket.off('game:updated', onGameEvent);
      socket.off('game:started', onGameEvent);
      socket.off('game:completed', onGameEvent);
      socket.off('game:expired', onGameEvent);
      socket.off('poll:updated', onPollUpdated);
      socket.off('call:group:ended', onGroupEnded);
      socket.off('call:group:joined', onGroupRoster);
      socket.off('call:error', onCallError);
    };
  }, [isAuthenticated, userId]);
}
