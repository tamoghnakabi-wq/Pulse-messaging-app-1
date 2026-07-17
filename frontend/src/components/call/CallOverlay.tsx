import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Phone,
  PhoneOff,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Loader2,
  X,
  SwitchCamera,
  ScreenShare,
  ScreenShareOff,
  Minimize2,
  Maximize2,
  UserPlus,
  Users,
} from 'lucide-react';
import { useCallStore } from '../../store/callStore';
import { useChatStore } from '../../store/chatStore';
import { useAuthStore } from '../../store/authStore';
import { webrtc } from '../../services/webrtc';
import { Button } from '../ui/Button';
import { Avatar } from '../ui/Avatar';
import { cn } from '../../utils/cn';
import toast from 'react-hot-toast';
import { GroupCallPicker } from './GroupCallPicker';

/**
 * Idle path: single store subscription, no video/media effects.
 * Active path mounts only while a call is live.
 */
export function CallOverlay() {
  const active = useCallStore((s) => s.active);
  if (!active) return null;
  return <CallOverlayActive />;
}

/**
 * Call UI — floating card by default.
 * Can be minimized to a compact bar (chat stays usable) or expanded
 * to a full-viewport video layout.
 * All hooks are declared unconditionally (no hooks after early return).
 */
function CallOverlayActive() {
  const status = useCallStore((s) => s.status);
  const callType = useCallStore((s) => s.callType);
  const isIncoming = useCallStore((s) => s.isIncoming);
  const localStream = useCallStore((s) => s.localStream);
  const remoteStream = useCallStore((s) => s.remoteStream);
  const remotePeerStreams = useCallStore((s) => s.remotePeerStreams);
  const remoteUserId = useCallStore((s) => s.remoteUserId);
  const conversationId = useCallStore((s) => s.conversationId);
  const error = useCallStore((s) => s.error);
  const muted = useCallStore((s) => s.muted);
  const videoOff = useCallStore((s) => s.videoOff);
  const relayMode = useCallStore((s) => s.relayMode);
  const facingMode = useCallStore((s) => s.facingMode);
  const switchingCamera = useCallStore((s) => s.switchingCamera);
  const sharingScreen = useCallStore((s) => s.sharingScreen);
  const isGroup = useCallStore((s) => s.isGroup);
  const members = useCallStore((s) => s.members);
  const minimized = useCallStore((s) => s.minimized);
  const setMinimized = useCallStore((s) => s.setMinimized);
  const fullscreen = useCallStore((s) => s.fullscreen);
  const setFullscreen = useCallStore((s) => s.setFullscreen);
  const acceptCall = useCallStore((s) => s.acceptCall);
  const rejectCall = useCallStore((s) => s.rejectCall);
  const endCall = useCallStore((s) => s.endCall);
  const inviteToGroupCall = useCallStore((s) => s.inviteToGroupCall);
  const toggleMute = useCallStore((s) => s.toggleMute);
  const toggleVideo = useCallStore((s) => s.toggleVideo);
  const switchCamera = useCallStore((s) => s.switchCamera);
  const stopScreenShare = useCallStore((s) => s.stopScreenShare);
  const attachScreenShare = useCallStore((s) => s.attachScreenShare);
  const clearError = useCallStore((s) => s.clearError);
  const [sharingBusy, setSharingBusy] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const meId = useAuthStore((s) => s.user?.id);
  const conversation = useChatStore((s) =>
    s.conversations.find((c) => c.id === conversationId)
  );
  // Resolve peer from conversation without re-subscribing to the whole list shape
  const remote = useMemo(() => {
    if (!conversation) return undefined;
    return (
      conversation.participants.find((p) => p.user.id === remoteUserId)?.user ||
      conversation.participants.find((p) => p.user.id !== meId)?.user
    );
  }, [conversation, remoteUserId, meId]);

  const participantUsers = useMemo(() => {
    if (!conversation) return [];
    return conversation.participants.map((p) => p.user).filter(Boolean);
  }, [conversation]);

  const userById = useMemo(() => {
    const m = new Map<string, (typeof participantUsers)[0]>();
    for (const u of participantUsers) m.set(u.id, u);
    return m;
  }, [participantUsers]);

  const joinedOthers = useMemo(() => {
    return (members || []).filter(
      (m) => m.status === 'joined' && m.userId !== meId
    );
  }, [members, meId]);

  const ringingCount = useMemo(
    () => (members || []).filter((m) => m.status === 'invited').length,
    [members]
  );

  const excludeFromInvite = useMemo(() => {
    const fromRoster = (members || [])
      .filter((m) => m.status === 'joined' || m.status === 'invited')
      .map((m) => m.userId);
    // Always exclude the active 1:1 peer if present
    if (remoteUserId && !fromRoster.includes(remoteUserId)) {
      return [...fromRoster, remoteUserId];
    }
    return fromRoster;
  }, [members, remoteUserId]);

  const localRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  /** Host for remote JPEG paint canvas (crisper than captureStream→video when fullscreen). */
  const remoteCanvasHostRef = useRef<HTMLDivElement>(null);
  const peerVideoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const [accepting, setAccepting] = useState(false);
  const [hasRemoteCanvas, setHasRemoteCanvas] = useState(false);

  const groupTitle =
    conversation?.displayName || conversation?.name || 'Group call';
  const remoteName = isGroup
    ? groupTitle
    : remote?.displayName || remote?.username || 'User';
  // Show video layout for camera/screen calls, while we share, or when peer sends video frames
  const peerStreamCount = Object.keys(remotePeerStreams || {}).length;
  const isVideo =
    callType === 'video' ||
    callType === 'screen' ||
    sharingScreen ||
    !!remoteStream ||
    peerStreamCount > 0;
  // Must be defined before effects that depend on it (TDZ crash if placed later)
  const showIncomingActions = Boolean(isIncoming && status === 'ringing');
  const canFullscreen = isVideo && !showIncomingActions;
  const isFullscreen = fullscreen && canFullscreen;
  /** Front/back flip: phone/tablet only (not desktop — no dual cameras). */
  const [isPhoneUi, setIsPhoneUi] = useState(false);
  const canFlipCamera = callType === 'video' && isPhoneUi && !sharingScreen;

  useEffect(() => {
    if (error) {
      toast.error(error);
      clearError();
    }
  }, [error, clearError]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Phone / narrow layout only — desktop never shows camera flip
    const mq = window.matchMedia('(max-width: 767px)');
    const sync = () => setIsPhoneUi(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  /**
   * Bind local PiP. Stable key (no status) so connecting→connected does not remount
   * a blank &lt;video&gt;. Callback ref always re-binds when the element mounts.
   */
  const bindLocalPreview = useCallback(
    (el: HTMLVideoElement | null) => {
      localRef.current = el;
      if (!el || !localStream || videoOff) return;
      el.muted = true;
      el.defaultMuted = true;
      el.playsInline = true;
      el.setAttribute('playsinline', 'true');
      el.setAttribute('webkit-playsinline', 'true');
      el.autoplay = true;
      if (el.srcObject !== localStream) {
        el.srcObject = localStream;
      }
      const play = () => void el.play().catch(() => undefined);
      play();
      el.onloadedmetadata = play;
    },
    [localStream, videoOff]
  );

  useEffect(() => {
    if (!isVideo || videoOff || !localStream) return;
    const el = localRef.current;
    if (el) bindLocalPreview(el);
    // Track can become live a moment after getUserMedia resolves
    const t1 = window.setTimeout(() => {
      const v = localRef.current;
      if (v) bindLocalPreview(v);
    }, 120);
    const t2 = window.setTimeout(() => {
      const v = localRef.current;
      if (v && v.paused) void v.play().catch(() => undefined);
    }, 400);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [localStream, isVideo, videoOff, switchingCamera, sharingScreen, bindLocalPreview]);

  // Tell the media layer when the UI is full-screen so encode adapt keeps quality
  useEffect(() => {
    webrtc.setViewerFullscreen(isFullscreen);
    return () => {
      webrtc.setViewerFullscreen(false);
    };
  }, [isFullscreen]);

  /**
   * Mount the remote paint canvas into the call UI.
   * Avoids captureStream→&lt;video&gt; which looks soft when CSS-scaled to full viewport.
   * Stable deps — do not remount on every remoteStream notify / frame.
   */
  useEffect(() => {
    if (!isVideo || isGroup) {
      setHasRemoteCanvas(false);
      return;
    }
    const host = remoteCanvasHostRef.current;
    if (!host) return;
    let cancelled = false;
    let attached = false;

    const applyCanvasStyles = (canvas: HTMLCanvasElement) => {
      canvas.className = cn(
        'remote-call-canvas block bg-black',
        isFullscreen
          ? 'h-full w-full max-h-none'
          : 'h-auto max-h-56 min-h-[10.5rem] w-full'
      );
      canvas.style.width = '100%';
      canvas.style.height = isFullscreen ? '100%' : 'auto';
      canvas.style.maxHeight = isFullscreen ? 'none' : '14rem';
      canvas.style.objectFit = 'contain';
      canvas.style.objectPosition = 'center';
      canvas.style.transform = 'translateZ(0)';
      canvas.style.imageRendering = 'auto';
    };

    const mount = () => {
      if (cancelled) return;
      const canvas = webrtc.getRemoteVideoCanvas();
      if (!canvas) return;
      applyCanvasStyles(canvas);
      if (canvas.parentElement !== host) {
        host.replaceChildren(canvas);
      }
      if (!attached) {
        attached = true;
        setHasRemoteCanvas(true);
      }
    };

    mount();
    // Subscribe but only attach once — style updates still applied
    const unsub = webrtc.subscribe(() => {
      if (!attached) mount();
      else {
        const canvas = webrtc.getRemoteVideoCanvas();
        if (canvas && canvas.parentElement === host) applyCanvasStyles(canvas);
      }
    });
    const poll = window.setInterval(() => {
      if (!attached) mount();
      else window.clearInterval(poll);
    }, 200);
    return () => {
      cancelled = true;
      unsub();
      window.clearInterval(poll);
      const canvas = webrtc.getRemoteVideoCanvas();
      if (canvas && canvas.parentElement === host) {
        host.removeChild(canvas);
      }
      setHasRemoteCanvas(false);
    };
  }, [isVideo, isGroup, isFullscreen]);

  // Fallback: bind captureStream to <video> only if canvas host isn't used
  useEffect(() => {
    if (hasRemoteCanvas || isGroup) return;
    const el = remoteVideoRef.current;
    if (!el || !remoteStream) return;
    if (el.srcObject !== remoteStream) {
      el.srcObject = remoteStream;
    }
    void el.play().catch(() => undefined);
  }, [remoteStream, isVideo, status, hasRemoteCanvas, isGroup]);

  // Bind per-peer group video elements
  useEffect(() => {
    if (!isGroup || !remotePeerStreams) return;
    for (const [uid, stream] of Object.entries(remotePeerStreams)) {
      const el = peerVideoRefs.current[uid];
      if (!el || !stream) continue;
      if (el.srcObject !== stream) el.srcObject = stream;
      void el.play().catch(() => undefined);
    }
  }, [isGroup, remotePeerStreams, status, isVideo]);

  const statusLabel = (() => {
    if (status === 'ringing' && isIncoming) {
      return isGroup ? 'Incoming group call' : 'Incoming call';
    }
    if (status === 'ringing') return 'Calling…';
    if (status === 'connecting') {
      if (isGroup && ringingCount > 0) return `Ringing ${ringingCount}…`;
      return 'Connecting…';
    }
    if (status === 'connected') {
      if (sharingScreen || callType === 'screen') return 'Sharing screen';
      if (isGroup) {
        const n = joinedOthers.length + 1;
        return `${n} on call${ringingCount ? ` · ${ringingCount} ringing` : ''}`;
      }
      if (isVideo && remoteStream) return 'Video call';
      return 'Connected';
    }
    return 'In call';
  })();

  const onAccept = async () => {
    setAccepting(true);
    try {
      await acceptCall();
    } catch {
      toast.error('Could not accept call');
    } finally {
      setAccepting(false);
    }
  };

  /** Invite more group members from this call window */
  const canAddPeople = Boolean(
    conversation?.type === 'group' && !showIncomingActions && (isGroup || !!conversationId)
  );
  const inviteCandidatesLeft = useMemo(() => {
    if (!conversation || !canAddPeople) return 0;
    const excl = new Set(excludeFromInvite.map(String));
    if (meId) excl.add(meId);
    return (conversation.participants || []).filter(
      (p) => p.user?.id && !excl.has(p.user.id)
    ).length;
  }, [conversation, canAddPeople, excludeFromInvite, meId]);

  const canScreenShare =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getDisplayMedia &&
    status === 'connected' &&
    !showIncomingActions;

  /**
   * Screen share MUST call getDisplayMedia in the same turn as the click.
   * Any await/setState before that throws "must be called from a user gesture handler".
   */
  const onToggleScreenShare = () => {
    if (sharingBusy) return;
    if (sharingScreen) {
      setSharingBusy(true);
      void stopScreenShare().finally(() => setSharingBusy(false));
      return;
    }
    // Synchronous start of the browser picker (user gesture — no await above this line)
    let displayPromise: Promise<MediaStream>;
    try {
      displayPromise = webrtc.requestDisplayMedia();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Screen share failed';
      toast.error(msg);
      return;
    }
    setSharingBusy(true);
    void attachScreenShare(displayPromise)
      .then(() => {
        // After picker: remind how to get a stable full-desktop share
        const surface = webrtc.localStream
          ?.getVideoTracks()[0]
          ?.getSettings() as MediaTrackSettings & { displaySurface?: string };
        const s = surface?.displaySurface;
        if (s === 'browser') {
          toast(
            'You shared a tab. For the whole desktop choose “Entire Screen” (best in Chrome/Edge). Sharing Safari freezes when minimized.',
            { duration: 6000, icon: '🖥️' }
          );
        } else if (s === 'window') {
          toast(
            'You shared one window — minimizing it pauses the share. Use “Entire Screen” for a continuous feed.',
            { duration: 5500, icon: '🖥️' }
          );
        }
      })
      .finally(() => setSharingBusy(false));
  };

  // Incoming must stay expanded so Accept / Decline remain obvious
  const canMinimize = !showIncomingActions;
  const isMinimized = minimized && canMinimize;

  // Escape exits full-screen back to the floating card
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen, setFullscreen]);

  // Compact bar — chat remains fully interactive underneath
  if (isMinimized) {
    return (
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex justify-center p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:justify-end sm:p-4"
        role="dialog"
        aria-label="Call minimized"
      >
        <div className="call-card animate-scale-in pointer-events-auto flex max-w-[min(100%,22rem)] items-center gap-2 rounded-full border border-white/12 bg-[#1c1c1e]/96 py-2 pl-2 pr-2 text-white shadow-2xl md:backdrop-blur-2xl sm:max-w-sm">
          <button
            type="button"
            className="pressable flex min-w-0 flex-1 items-center gap-2.5 rounded-full py-1 pl-1 pr-2 text-left"
            onClick={() => setMinimized(false)}
            aria-label="Expand call"
          >
            <Avatar src={isGroup ? conversation?.avatar : remote?.avatar} name={remoteName} size="sm" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-[-0.02em]">{remoteName}</p>
              <p className="truncate text-[11px] text-white/55">
                {status === 'connected' ? (
                  <span className="inline-flex items-center gap-1 text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    {isGroup
                      ? `${joinedOthers.length + 1} on call · Tap to expand`
                      : 'On call · Tap to expand'}
                  </span>
                ) : (
                  statusLabel
                )}
              </p>
            </div>
          </button>
          <Button
            size="icon"
            className={cn(
              'h-10 w-10 shrink-0 rounded-full border border-white/10 text-white',
              muted ? 'bg-white/25' : 'bg-white/12 hover:bg-white/20'
            )}
            aria-label={muted ? 'Unmute' : 'Mute'}
            onClick={toggleMute}
          >
            {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </Button>
          <Button
            size="icon"
            className="h-10 w-10 shrink-0 rounded-full bg-white/12 text-white hover:bg-white/20"
            aria-label="Expand call"
            onClick={() => setMinimized(false)}
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="danger"
            className="h-10 w-10 shrink-0 rounded-full shadow-lg shadow-red-500/30"
            aria-label="End call"
            onClick={() => endCall(true)}
          >
            <PhoneOff className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

return (
    <div
      className={cn(
        'pointer-events-none fixed z-[100]',
        isFullscreen
          ? 'inset-0 flex'
          : 'inset-x-0 bottom-0 flex justify-center p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4'
      )}
      role="dialog"
      aria-modal="true"
      aria-label={isFullscreen ? 'Video call full screen' : 'Call'}
    >
      <div
        className={cn(
          'call-card pointer-events-auto text-white transition-shadow duration-300',
          isFullscreen
            ? 'flex h-full w-full max-w-none flex-col overflow-hidden rounded-none border-0 bg-black'
            : 'animate-scale-in w-full max-w-md overflow-hidden rounded-[1.75rem] border border-white/12 bg-[#1c1c1e]/96 md:backdrop-blur-2xl'
        )}
      >
        {/* Header */}
        <div
          className={cn(
            'flex shrink-0 items-center justify-between border-b border-white/[0.08] px-4 py-3.5',
            isFullscreen && 'absolute inset-x-0 top-0 z-10 border-b-0 bg-gradient-to-b from-black/80 via-black/40 to-transparent pt-[max(0.75rem,env(safe-area-inset-top))] pb-8'
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            <Avatar
              src={isGroup ? conversation?.avatar : remote?.avatar}
              name={remoteName}
              size="md"
            />
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold tracking-[-0.02em]">
                {remoteName}
                {isGroup && (
                  <span className="ml-1.5 inline-flex items-center gap-0.5 align-middle text-[11px] font-medium text-white/45">
                    <Users className="h-3 w-3" />
                    Group
                  </span>
                )}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs tracking-[-0.01em] text-white/55">
                <span>{statusLabel}</span>
                {status === 'connected' && (
                  <span className="presence-dot presence-dot-online inline-block h-1.5 w-1.5 !border-0" />
                )}
                {status === 'connected' && (
                  <span
                    className={cn(
                      'call-quality ml-0.5',
                      relayMode ? 'call-quality-relay' : 'call-quality-good'
                    )}
                    title={relayMode ? 'Relayed connection' : 'Direct connection'}
                    aria-hidden
                  >
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                )}
                {relayMode && status === 'connected' && (
                  <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-white/50">
                    Relay
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {canAddPeople && conversation && (
              <button
                type="button"
                aria-label="Add members to call"
                title={
                  inviteCandidatesLeft > 0
                    ? 'Add members to this call'
                    : 'Everyone in the group is already on the call'
                }
                disabled={inviteCandidatesLeft === 0}
                className={cn(
                  'pressable flex h-10 items-center justify-center gap-1.5 rounded-full bg-pulse-500/90 px-3 text-white shadow-md shadow-pulse-500/25 transition-colors duration-200 hover:bg-pulse-500',
                  inviteCandidatesLeft === 0 && 'opacity-40'
                )}
                onClick={() => setInviteOpen(true)}
              >
                <UserPlus className="h-4 w-4 shrink-0" />
                <span className="hidden text-xs font-semibold tracking-[-0.01em] sm:inline">
                  Add
                </span>
              </button>
            )}
            {canFullscreen && (
              <button
                type="button"
                aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
                title={isFullscreen ? 'Exit full screen (Esc)' : 'Full screen video'}
                className="pressable flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors duration-200 hover:bg-white/18"
                onClick={() => setFullscreen(!isFullscreen)}
              >
                {isFullscreen ? (
                  <Minimize2 className="h-5 w-5" />
                ) : (
                  <Maximize2 className="h-5 w-5" />
                )}
              </button>
            )}
            {/* Minimize to bar is only on the card — full screen uses Exit above */}
            {canMinimize && !isFullscreen && (
              <button
                type="button"
                aria-label="Minimize call"
                title="Minimize — keep chatting"
                className="pressable flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors duration-200 hover:bg-white/18"
                onClick={() => setMinimized(true)}
              >
                <Minimize2 className="h-5 w-5" />
              </button>
            )}
            <button
              type="button"
              aria-label={showIncomingActions ? 'Decline call' : 'Leave call'}
              className="pressable flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors duration-200 hover:bg-white/18"
              onClick={() => (showIncomingActions ? rejectCall() : endCall(true))}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div
          className={cn(
            'flex flex-col items-center',
            isFullscreen
              ? 'relative min-h-0 flex-1 justify-end px-0 pb-[max(1rem,env(safe-area-inset-bottom))] pt-0'
              : 'px-4 py-5 sm:px-5 sm:py-6'
          )}
        >
          {isVideo ? (
            <div
              className={cn(
                'relative w-full overflow-hidden bg-black',
                isFullscreen
                  ? 'absolute inset-0 rounded-none ring-0'
                  : 'mb-4 rounded-2xl ring-1 ring-white/10 shadow-inner'
              )}
            >
              {isGroup ? (
                <div
                  className={cn(
                    'grid w-full gap-1 bg-black p-1',
                    isFullscreen ? 'h-full min-h-0' : 'min-h-[10.5rem] max-h-72',
                    joinedOthers.length <= 1
                      ? 'grid-cols-1'
                      : joinedOthers.length <= 4
                        ? 'grid-cols-2'
                        : 'grid-cols-2 sm:grid-cols-3'
                  )}
                >
                  {(joinedOthers.length
                    ? joinedOthers
                    : (members || []).filter((m) => m.userId !== meId).slice(0, 4)
                  ).map((m) => {
                    const u = userById.get(m.userId);
                    const name = u?.displayName || u?.username || 'Member';
                    const stream = remotePeerStreams?.[m.userId];
                    return (
                      <div
                        key={m.userId}
                        className={cn(
                          'relative flex items-center justify-center overflow-hidden rounded-lg bg-[#111]',
                          isFullscreen ? 'min-h-0' : 'min-h-[5.5rem]'
                        )}
                      >
                        {stream ? (
                          <video
                            ref={(el) => {
                              peerVideoRefs.current[m.userId] = el;
                            }}
                            autoPlay
                            playsInline
                            muted
                            className="h-full w-full object-contain"
                          />
                        ) : (
                          <div className="flex flex-col items-center gap-1.5 p-3">
                            <Avatar src={u?.avatar} name={name} size="md" />
                            <span className="max-w-full truncate px-1 text-[10px] text-white/55">
                              {m.status === 'invited' ? 'Ringing…' : name}
                            </span>
                          </div>
                        )}
                        {stream && (
                          <span className="absolute bottom-1.5 left-1.5 max-w-[90%] truncate rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white/85">
                            {name}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {!joinedOthers.length && !(members || []).filter((m) => m.userId !== meId).length && (
                    <div className="flex min-h-[10.5rem] flex-col items-center justify-center gap-2 py-8">
                      <Avatar src={conversation?.avatar} name={groupTitle} size="xl" />
                      <p className="text-xs text-white/45">Waiting for others…</p>
                    </div>
                  )}
                  {canAddPeople && inviteCandidatesLeft > 0 && (
                    <button
                      type="button"
                      onClick={() => setInviteOpen(true)}
                      className={cn(
                        'flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/25 bg-white/[0.04] text-white/70 transition-colors hover:border-pulse-400/50 hover:bg-pulse-500/15 hover:text-white',
                        isFullscreen ? 'min-h-[5rem]' : 'min-h-[5.5rem]'
                      )}
                      aria-label="Add members to call"
                    >
                      <UserPlus className="h-6 w-6" />
                      <span className="text-[10px] font-semibold tracking-wide">Add</span>
                    </button>
                  )}
                </div>
              ) : (
                <>
                  {/* Crisp path: paint canvas mounted here (see remoteCanvasHostRef effect) */}
                  <div
                    ref={remoteCanvasHostRef}
                    className={cn(
                      'flex w-full items-center justify-center bg-black',
                      isFullscreen
                        ? 'h-full min-h-0'
                        : hasRemoteCanvas || remoteStream
                          ? 'min-h-[10.5rem] max-h-56'
                          : 'hidden'
                    )}
                  />
                  {/* Fallback if canvas not ready yet */}
                  {!hasRemoteCanvas && remoteStream && (
                    <video
                      ref={remoteVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className={cn(
                        'w-full object-contain',
                        // GPU layer; muted — audio is PCM, not on this track
                        '[transform:translateZ(0)]',
                        isFullscreen
                          ? 'absolute inset-0 h-full max-h-none min-h-0'
                          : 'max-h-56 min-h-[10.5rem]'
                      )}
                    />
                  )}
                  {!hasRemoteCanvas && !remoteStream && (
                    <div
                      className={cn(
                        'flex w-full flex-col items-center justify-center gap-2.5',
                        isFullscreen ? 'h-full min-h-[50vh]' : 'min-h-[10.5rem] py-8'
                      )}
                    >
                      <Avatar src={remote?.avatar} name={remoteName} size="xl" />
                      <p className="text-xs font-medium tracking-[-0.01em] text-white/45">
                        {status === 'connected' ? 'Waiting for their camera…' : 'Connecting video…'}
                      </p>
                    </div>
                  )}
                </>
              )}
              {localStream && (!videoOff || sharingScreen) ? (
                <video
                  // Do NOT include status in key — remount on connect left a black PiP
                  key={`local-${localStream.id}-${sharingScreen ? 'scr' : 'cam'}`}
                  ref={bindLocalPreview}
                  autoPlay
                  playsInline
                  muted
                  // Mirror front camera only (never mirror screen share)
                  className={cn(
                    'absolute z-[5] rounded-xl border border-white/30 bg-black shadow-xl ring-1 ring-black/40',
                    isFullscreen
                      ? 'bottom-[max(5.5rem,calc(env(safe-area-inset-bottom)+5rem))] right-4 h-36 w-24 sm:h-40 sm:w-28'
                      : 'bottom-2.5 right-2.5 h-24 w-16',
                    sharingScreen ? 'object-contain' : 'object-cover',
                    !sharingScreen &&
                      callType === 'video' &&
                      facingMode === 'user' &&
                      'scale-x-[-1]'
                  )}
                />
              ) : (
                isVideo && (
                  <div
                    className={cn(
                      'absolute flex items-center justify-center rounded-xl border border-white/20 bg-black/75 text-[10px] font-medium tracking-wide text-white/60',
                      isFullscreen
                        ? 'bottom-[max(5.5rem,calc(env(safe-area-inset-bottom)+5rem))] right-4 h-36 w-24 sm:h-40 sm:w-28'
                        : 'bottom-2.5 right-2.5 h-24 w-16'
                    )}
                  >
                    Cam off
                  </div>
                )
              )}
            </div>
          ) : isGroup ? (
            <div className="mb-4 flex w-full flex-wrap items-center justify-center gap-3">
              {(joinedOthers.length
                ? joinedOthers
                : (members || []).filter((m) => m.userId !== meId).slice(0, 6)
              ).map((m) => {
                const u = userById.get(m.userId);
                const name = u?.displayName || u?.username || 'Member';
                return (
                  <div key={m.userId} className="flex w-16 flex-col items-center gap-1">
                    <div className="relative">
                      {(status === 'connecting' || m.status === 'invited') && (
                        <span className="call-ring absolute inset-0 rounded-full bg-pulse-500/25" />
                      )}
                      <Avatar src={u?.avatar} name={name} size="lg" />
                    </div>
                    <span className="w-full truncate text-center text-[10px] text-white/55">
                      {m.status === 'invited' ? 'Ringing' : name.split(' ')[0]}
                    </span>
                  </div>
                );
              })}
              {canAddPeople && inviteCandidatesLeft > 0 && (
                <button
                  type="button"
                  onClick={() => setInviteOpen(true)}
                  className="flex w-16 flex-col items-center gap-1"
                  aria-label="Add members to call"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-white/30 bg-white/10 text-white hover:border-pulse-400/60 hover:bg-pulse-500/20">
                    <UserPlus className="h-5 w-5" />
                  </span>
                  <span className="w-full truncate text-center text-[10px] font-medium text-pulse-300">
                    Add
                  </span>
                </button>
              )}
              {!joinedOthers.length && !(members || []).some((m) => m.userId !== meId) && (
                <div className="relative mb-1 flex h-28 w-28 items-center justify-center">
                  <Avatar src={conversation?.avatar} name={groupTitle} size="xl" />
                </div>
              )}
            </div>
          ) : (
            <div className="relative mb-5 flex h-28 w-28 items-center justify-center">
              {(status === 'connecting' || status === 'ringing') && (
                <>
                  {/* CSS-only pulse ring — avoid animate-ping continuous layout thrash on mobile */}
                  <span className="call-ring absolute inset-0 rounded-full bg-pulse-500/25" />
                  <span className="absolute -inset-1 rounded-full bg-pulse-500/10 ring-1 ring-pulse-400/30" />
                </>
              )}
              <div className="relative rounded-full ring-4 ring-pulse-500/25 shadow-lg shadow-pulse-500/20">
                <Avatar src={remote?.avatar} name={remoteName} size="xl" />
              </div>
            </div>
          )}

          {!isFullscreen && (status === 'connecting' || status === 'ringing') && !showIncomingActions && (
            <div className="mb-3 flex items-center gap-2 text-sm font-medium tracking-[-0.01em] text-white/65">
              <Loader2 className="h-4 w-4 animate-spin text-pulse-400" />
              {status === 'ringing' ? 'Ringing…' : 'Connecting…'}
            </div>
          )}

          {!isFullscreen && status === 'connected' && (
            <p className="mb-3 text-sm font-medium tracking-[-0.01em] text-emerald-400/95">
              {sharingScreen || callType === 'screen'
                ? 'Screen sharing'
                : isGroup
                  ? `${joinedOthers.length + 1} people on the call`
                  : isVideo
                    ? 'Video connected'
                    : 'You can talk now'}
            </p>
          )}

          {/* Explicit in-call add-members action (group chats) */}
          {canAddPeople && conversation && !isFullscreen && !showIncomingActions && (
            <button
              type="button"
              onClick={() => setInviteOpen(true)}
              disabled={inviteCandidatesLeft === 0}
              className={cn(
                'mb-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-white/12 bg-white/10 px-4 py-2.5 text-sm font-semibold tracking-[-0.01em] text-white transition-colors hover:bg-white/16',
                inviteCandidatesLeft === 0 && 'cursor-not-allowed opacity-45 hover:bg-white/10'
              )}
            >
              <UserPlus className="h-4 w-4 text-pulse-300" />
              {inviteCandidatesLeft > 0
                ? `Add members (${inviteCandidatesLeft} available)`
                : 'All members are on the call'}
            </button>
          )}

          <div
            className={cn(
              'flex w-full flex-wrap items-center justify-center gap-3',
              isFullscreen
                ? 'relative z-10 bg-gradient-to-t from-black/80 via-black/50 to-transparent px-4 pb-2 pt-10'
                : 'pt-1'
            )}
          >
            {showIncomingActions ? (
              <>
                <Button
                  size="lg"
                  className="call-ctrl min-h-12 flex-1 rounded-full bg-emerald-500 shadow-lg shadow-emerald-500/30 hover:bg-emerald-600 hover:shadow-emerald-500/40"
                  loading={accepting}
                  onClick={() => void onAccept()}
                >
                  <Phone className="h-5 w-5" /> Accept
                </Button>
                <Button
                  size="lg"
                  variant="danger"
                  className="call-ctrl min-h-12 flex-1 rounded-full"
                  onClick={rejectCall}
                >
                  <PhoneOff className="h-5 w-5" /> Decline
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="icon"
                  className={cn(
                    'call-ctrl h-14 w-14 rounded-full border border-white/10 text-white shadow-lg',
                    muted
                      ? 'bg-white/25 ring-2 ring-white/20'
                      : 'call-mic-live bg-white/12 hover:bg-white/20'
                  )}
                  aria-label={muted ? 'Unmute' : 'Mute'}
                  onClick={toggleMute}
                >
                  {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                </Button>
                {isVideo && !sharingScreen && (
                  <Button
                    size="icon"
                    className={cn(
                      'call-ctrl h-14 w-14 rounded-full border border-white/10 text-white shadow-lg',
                      videoOff ? 'bg-white/25 ring-2 ring-white/20' : 'bg-white/12 hover:bg-white/20'
                    )}
                    aria-label={videoOff ? 'Camera on' : 'Camera off'}
                    onClick={toggleVideo}
                  >
                    {videoOff ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
                  </Button>
                )}
                {canFlipCamera && (
                  <Button
                    size="icon"
                    className="call-ctrl h-14 w-14 rounded-full border border-white/10 bg-white/12 text-white shadow-lg hover:bg-white/20 disabled:opacity-50"
                    aria-label="Switch camera"
                    title="Switch camera"
                    disabled={switchingCamera}
                    loading={switchingCamera}
                    onClick={() => void switchCamera()}
                  >
                    {!switchingCamera && <SwitchCamera className="h-5 w-5" />}
                  </Button>
                )}
                {canScreenShare && (
                  <Button
                    size="icon"
                    className={cn(
                      'call-ctrl h-14 w-14 rounded-full border border-white/10 text-white shadow-lg',
                      sharingScreen
                        ? 'bg-pulse-500/90 ring-2 ring-pulse-400/40 hover:bg-pulse-500'
                        : 'bg-white/12 hover:bg-white/20'
                    )}
                    aria-label={sharingScreen ? 'Stop sharing' : 'Share screen'}
                    title={sharingScreen ? 'Stop sharing' : 'Share screen'}
                    disabled={sharingBusy}
                    loading={sharingBusy}
                    onClick={onToggleScreenShare}
                  >
                    {!sharingBusy &&
                      (sharingScreen ? (
                        <ScreenShareOff className="h-5 w-5" />
                      ) : (
                        <ScreenShare className="h-5 w-5" />
                      ))}
                  </Button>
                )}
                {canAddPeople && conversation && (
                  <Button
                    size="icon"
                    className="call-ctrl h-14 w-14 rounded-full border border-pulse-400/40 bg-pulse-500/90 text-white shadow-lg shadow-pulse-500/30 hover:bg-pulse-500"
                    aria-label="Add members"
                    title="Add members to this call"
                    disabled={inviteCandidatesLeft === 0}
                    onClick={() => setInviteOpen(true)}
                  >
                    <UserPlus className="h-5 w-5" />
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="danger"
                  className="h-14 w-14 rounded-full shadow-lg shadow-red-500/35 hover:shadow-red-500/45"
                  aria-label={isGroup ? 'Leave call' : 'End call'}
                  onClick={() => endCall(true)}
                >
                  <PhoneOff className="h-5 w-5" />
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Member picker stacks above call UI (elevated modal) */}
      {canAddPeople && conversation && (
        <div className="pointer-events-auto">
          <GroupCallPicker
            open={inviteOpen}
            onClose={() => setInviteOpen(false)}
            conversation={conversation}
            mode="invite"
            elevated
            excludeUserIds={excludeFromInvite}
            onConfirm={({ inviteUserIds }) => {
              try {
                inviteToGroupCall(inviteUserIds);
                toast.success(
                  inviteUserIds.length === 1
                    ? 'Added 1 person to the call'
                    : `Added ${inviteUserIds.length} people to the call`
                );
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Could not add members');
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
