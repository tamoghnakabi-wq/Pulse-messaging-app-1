import type { Message } from './message';
import type { User } from './user';

export interface Participant {
  user: User;
  role: 'member' | 'admin' | 'owner';
  joinedAt?: string;
  lastReadAt?: string;
  isMuted?: boolean;
  isPinned?: boolean;
  isArchived?: boolean;
  isFavorite?: boolean;
}

export interface ConversationPrefs {
  isPinned: boolean;
  isArchived: boolean;
  isFavorite: boolean;
  isMuted: boolean;
  role: string;
  lastReadAt?: string;
}

export interface Conversation {
  id: string;
  type: 'direct' | 'group';
  name?: string;
  displayName: string;
  description?: string;
  avatar?: string;
  isOnline?: boolean;
  lastSeen?: string;
  participants: Participant[];
  lastMessage?: Message;
  lastMessageAt?: string;
  pinnedMessages?: string[];
  inviteCode?: string;
  myPrefs?: ConversationPrefs;
  unreadCount?: number;
  hasPinnedMessages?: boolean;
  hasStarredMessages?: boolean;
  /** Group E2E key distribution (opaque wrapped keys) */
  e2eVersion?: number;
  e2eWrappedKeys?: { userId: string; wrappedKey: string }[];
  createdAt?: string;
  updatedAt?: string;
}

export type SidebarFilter =
  | 'all'
  | 'groups'
  | 'pinned'
  | 'archived'
  | 'favorites'
  | 'calls';
