export type CallHistoryType = 'audio' | 'video' | 'screen';
export type CallHistoryStatus = 'ringing' | 'active' | 'completed' | 'rejected' | 'missed';
export type CallHistoryDirection = 'incoming' | 'outgoing';

export interface CallHistoryUser {
  id: string;
  username: string;
  displayName: string;
  avatar?: string | null;
}

export interface CallHistoryItem {
  id: string;
  callId: string;
  conversationId: string | null;
  callType: CallHistoryType;
  status: CallHistoryStatus;
  direction: CallHistoryDirection;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number;
  otherUser: CallHistoryUser;
}
