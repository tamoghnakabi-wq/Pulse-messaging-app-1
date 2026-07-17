import type { User } from './user';

export interface Attachment {
  id?: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  url: string;
  thumbnailUrl?: string;
  duration?: number;
  width?: number;
  height?: number;
  /**
   * Ciphertext attachment — server stores application/octet-stream only.
   * Real mime/name live inside e2eMeta (client decrypts).
   */
  isE2E?: boolean;
  /** Opaque media crypto envelope (e2e-media:2:…); never parse server-side */
  e2eMeta?: string;
  /** Client-declared UI class when mime is opaque (image|video|audio|document|voice) */
  mediaClass?: string;
}

export interface Reaction {
  emoji: string;
  users: string[] | User[];
}

export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'voice'
  | 'system';

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

export interface Message {
  id: string;
  conversation: string;
  sender: User | string;
  type: MessageType;
  content: string;
  attachments: Attachment[];
  replyTo?: Message | string;
  forwardedFrom?: Message | string;
  reactions: Reaction[];
  mentions?: User[] | string[];
  deliveredTo?: string[];
  readBy?: { user: string; readAt: string }[];
  isEdited?: boolean;
  editedAt?: string;
  isDeleted?: boolean;
  isPinned?: boolean;
  /** Photo that recipients can open only once */
  viewOnce?: boolean;
  /** Current user has opened this view-once (or, for sender, someone has) */
  viewOnceOpened?: boolean;
  /** Current user may open (recipient, not yet opened) */
  viewOnceCanOpen?: boolean;
  viewOnceViewedBy?: string[];
  linkPreview?: LinkPreview;
  clientId?: string;
  /** Content is client-side E2E ciphertext */
  isE2E?: boolean;
  createdAt: string;
  updatedAt?: string;
  /** Chat display name when returned from pinned/starred lists */
  chatName?: string;
}

export interface SenderIdentity {
  id: string;
  displayName?: string;
  username?: string;
  avatar?: string;
}
