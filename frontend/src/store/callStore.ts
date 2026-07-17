import { create } from 'zustand';
import type { CallMember, CallState, CallType } from '../types';
import { webrtc } from '../services/webrtc';

interface CallStore extends CallState {
  muted: boolean;
  videoOff: boolean;
  relayMode: boolean;
  facingMode: 'user' | 'environment';
  switchingCamera: boolean;
  sharingScreen: boolean;
  /** Compact floating bar so chat stays usable during a call */
  minimized: boolean;
  setMinimized: (v: boolean) => void;
  /** Full-viewport video call UI */
  fullscreen: boolean;
  setFullscreen: (v: boolean) => void;
  startCall: (opts: {
    conversationId: string;
    remoteUserId: string;
    callType: CallType;
    displayPromise?: Promise<MediaStream>;
  }) => Promise<void>;
  /** Multi-party call in a group conversation */
  startGroupCall: (opts: {
    conversationId: string;
    inviteUserIds: string[];
    callType: CallType;
    displayPromise?: Promise<MediaStream>;
  }) => Promise<void>;
  inviteToGroupCall: (inviteUserIds: string[]) => void;
  acceptCall: () => Promise<void>;
  rejectCall: () => void;
  endCall: (notifyRemote?: boolean) => void;
  handleIncoming: (payload: {
    callId: string;
    fromUserId: string;
    conversationId: string;
    callType: CallType;
    sdpOffer?: RTCSessionDescriptionInit;
    group?: boolean;
    initiatorId?: string;
    members?: CallMember[];
  }) => void;
  handleAnswer: (sdpAnswer?: RTCSessionDescriptionInit) => Promise<void>;
  handleIce: (candidate: RTCIceCandidateInit) => Promise<void>;
  handleMedia: (payload: {
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
  }) => void;
  handleGroupRoster: (payload: {
    callId?: string;
    members?: CallMember[];
    initiatorId?: string;
    callType?: CallType;
  }) => void;
  handleGroupPeerJoined: (payload: {
    userId?: string;
    members?: CallMember[];
    callId?: string;
  }) => void;
  handleGroupPeerLeft: (payload: {
    userId?: string;
    members?: CallMember[];
    callId?: string;
  }) => void;
  handleGroupPeerRejected: (payload: {
    userId?: string;
    members?: CallMember[];
    callId?: string;
  }) => void;
  handleGroupEnded: (payload?: { callId?: string }) => void;
  clearError: () => void;
  toggleMute: () => void;
  toggleVideo: () => void;
  switchCamera: () => Promise<void>;
  /** Stop in-call screen share (no gesture required). */
  stopScreenShare: () => Promise<void>;
  /**
   * Attach display stream started via webrtc.requestDisplayMedia() in a click handler.
   */
  attachScreenShare: (displayPromise: Promise<MediaStream>) => Promise<void>;
}

function syncFromService(): Partial<CallStore> {
  const status =
    webrtc.status === 'calling'
      ? 'connecting'
      : webrtc.status === 'ended'
        ? 'idle'
        : webrtc.status;

  return {
    active: webrtc.status !== 'idle' && webrtc.status !== 'ended',
    status: status as CallState['status'],
    callId: webrtc.callId || undefined,
    callType: webrtc.callType,
    remoteUserId: webrtc.remoteUserId || undefined,
    conversationId: webrtc.conversationId || undefined,
    isIncoming: webrtc.isIncoming,
    localStream: webrtc.localStream || undefined,
    remoteStream: webrtc.remoteStream || undefined,
    remotePeerStreams: { ...webrtc.remotePeerStreams },
    error: webrtc.error,
    muted: webrtc.isMuted(),
    videoOff: webrtc.isVideoOff(),
    relayMode: webrtc.relayMode,
    facingMode: webrtc.getFacingMode(),
    sharingScreen: webrtc.isSharingScreen(),
    isGroup: webrtc.isGroup,
    initiatorId: webrtc.initiatorId || undefined,
    members: [...webrtc.members],
  };
}

export const useCallStore = create<CallStore>((set) => {
  webrtc.subscribe(() => {
    set(syncFromService());
  });

  return {
    active: false,
    status: 'idle',
    error: null,
    muted: false,
    videoOff: false,
    relayMode: false,
    facingMode: 'user',
    switchingCamera: false,
    sharingScreen: false,
    minimized: false,
    fullscreen: false,
    isGroup: false,
    members: [],
    remotePeerStreams: {},

    setMinimized: (v) =>
      set(v ? { minimized: true, fullscreen: false } : { minimized: false }),
    setFullscreen: (v) =>
      set(v ? { fullscreen: true, minimized: false } : { fullscreen: false }),

    clearError: () => {
      webrtc.error = null;
      set({ error: null });
    },

    startCall: async (opts) => {
      await webrtc.start(opts);
      set({ ...syncFromService(), minimized: false, fullscreen: false });
    },

    startGroupCall: async (opts) => {
      await webrtc.startGroup(opts);
      set({ ...syncFromService(), minimized: false, fullscreen: false });
    },

    inviteToGroupCall: (inviteUserIds) => {
      webrtc.inviteToGroup(inviteUserIds);
      set(syncFromService());
    },

    acceptCall: async () => {
      await webrtc.accept();
      set({ ...syncFromService(), minimized: false, fullscreen: false });
    },

    rejectCall: () => {
      webrtc.reject();
      set({ ...syncFromService(), minimized: false, fullscreen: false });
    },

    endCall: (notifyRemote = true) => {
      void webrtc.hangup(notifyRemote);
      set({ ...syncFromService(), minimized: false, fullscreen: false });
    },

    handleIncoming: (payload) => {
      webrtc.onIncoming({
        callId: payload.callId,
        fromUserId: String(payload.fromUserId),
        conversationId: payload.conversationId,
        callType: payload.callType || 'audio',
        sdpOffer: payload.sdpOffer,
        group: payload.group,
        initiatorId: payload.initiatorId,
        members: payload.members,
      });
      // Always expand for incoming so Accept/Decline stay visible
      set({ ...syncFromService(), minimized: false, fullscreen: false });
    },

    handleAnswer: async (sdpAnswer) => {
      await webrtc.onRemoteAnswer(sdpAnswer);
      set(syncFromService());
    },

    handleIce: async (candidate) => {
      await webrtc.onRemoteIce(candidate);
    },

    handleMedia: (payload) => {
      // Audio/video frames are high-frequency — service notifies only when UI state changes
      const hadRemote = !!webrtc.remoteStream;
      const prevPeers = Object.keys(webrtc.remotePeerStreams).length;
      const prevStatus = webrtc.status;
      webrtc.onRemoteMedia(payload);
      if (
        !!webrtc.remoteStream !== hadRemote ||
        Object.keys(webrtc.remotePeerStreams).length !== prevPeers ||
        webrtc.status !== prevStatus
      ) {
        set(syncFromService());
      }
    },

    handleGroupRoster: (payload) => {
      if (payload.callId && webrtc.callId && payload.callId !== webrtc.callId) return;
      if (payload.members) {
        webrtc.applyGroupRoster(payload.members, {
          initiatorId: payload.initiatorId,
          callType: payload.callType,
        });
      }
      set(syncFromService());
    },

    handleGroupPeerJoined: (payload) => {
      if (payload.callId && webrtc.callId && payload.callId !== webrtc.callId) return;
      if (payload.userId) {
        webrtc.onGroupPeerJoined(String(payload.userId), payload.members);
      } else if (payload.members) {
        webrtc.applyGroupRoster(payload.members);
      }
      set(syncFromService());
    },

    handleGroupPeerLeft: (payload) => {
      if (payload.callId && webrtc.callId && payload.callId !== webrtc.callId) return;
      if (payload.userId) {
        webrtc.onGroupPeerLeft(String(payload.userId), payload.members);
      }
      set(syncFromService());
    },

    handleGroupPeerRejected: (payload) => {
      if (payload.callId && webrtc.callId && payload.callId !== webrtc.callId) return;
      if (payload.userId) {
        webrtc.onGroupPeerRejected(String(payload.userId), payload.members);
      }
      set(syncFromService());
    },

    handleGroupEnded: (payload) => {
      if (payload?.callId && webrtc.callId && payload.callId !== webrtc.callId) return;
      void webrtc.hangup(false);
      set({ ...syncFromService(), minimized: false, fullscreen: false });
    },

    toggleMute: () => {
      webrtc.toggleMute();
      set({ muted: webrtc.isMuted() });
    },

    toggleVideo: () => {
      webrtc.toggleVideo();
      set({ videoOff: webrtc.isVideoOff() });
    },

    switchCamera: async () => {
      set({ switchingCamera: true });
      try {
        await webrtc.switchCamera();
        set({
          ...syncFromService(),
          switchingCamera: false,
        });
      } catch {
        set({ switchingCamera: false, ...syncFromService() });
      }
    },

    stopScreenShare: async () => {
      try {
        await webrtc.stopScreenShare(true);
      } finally {
        set(syncFromService());
      }
    },

    attachScreenShare: async (displayPromise) => {
      try {
        await webrtc.attachScreenShare(displayPromise);
      } finally {
        set(syncFromService());
      }
    },
  };
});
