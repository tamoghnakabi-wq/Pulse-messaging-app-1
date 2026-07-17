/** Standard envelope returned by the Pulse REST API. */
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiErrorBody {
  success?: false;
  message?: string;
  code?: string;
  errors?: unknown;
}

/** Conversation list / prefs filter query. */
export type ConversationListFilter =
  | 'all'
  | 'groups'
  | 'pinned'
  | 'archived'
  | 'favorites';

export interface MessagePage {
  messages: import('../types').Message[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface StarMessageResult {
  starred: boolean;
  messageId: string;
  conversationId?: string;
  chatFavorite?: boolean;
}

export interface SendMessagePayload {
  content?: string;
  type?: string;
  replyTo?: string;
  mentions?: string[];
  clientId?: string;
  files?: File[];
  /** View-once photo (image-only messages) */
  viewOnce?: boolean;
  /** Content / attachments are E2E ciphertext */
  isE2E?: boolean;
  /**
   * Parallel to files[] — opaque e2e-media meta per attachment.
   * Server stores as-is; never interprets.
   */
  e2eMetas?: string[];
  /**
   * Client-declared message type when files are encrypted as octet-stream
   * (e.g. image/video) so UI typing still works without plaintext mime on server.
   */
  mediaTypes?: string[];
}

export interface ConversationPrefsUpdate {
  isPinned?: boolean;
  isArchived?: boolean;
  isFavorite?: boolean;
  isMuted?: boolean;
}

export interface AuthTokensResponse {
  user: import('../types').User;
  accessToken: string;
  refreshToken: string;
}
