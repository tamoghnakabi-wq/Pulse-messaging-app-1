import type { Conversation } from './conversation';
import type { User } from './user';

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  isRead: boolean;
  actor?: User;
  conversation?: Conversation | string;
  message?: string;
  createdAt: string;
}
