export type CallType = 'audio' | 'video' | 'screen';

export type CallStatus = 'idle' | 'ringing' | 'connecting' | 'connected' | 'ended';

export type GroupMemberStatus = 'invited' | 'joined' | 'left' | 'rejected';

export interface CallMember {
  userId: string;
  status: GroupMemberStatus;
}

export interface CallState {
  active: boolean;
  callId?: string;
  callType?: CallType;
  remoteUserId?: string;
  conversationId?: string;
  status: CallStatus;
  isIncoming?: boolean;
  localStream?: MediaStream;
  remoteStream?: MediaStream;
  /** Group: per-peer video streams keyed by userId */
  remotePeerStreams?: Record<string, MediaStream>;
  error?: string | null;
  /** Multi-party group call */
  isGroup?: boolean;
  initiatorId?: string;
  members?: CallMember[];
}
