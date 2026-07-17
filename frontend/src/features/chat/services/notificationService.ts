import api from '@/shared/api/client';
import { extractData } from '@/shared/api/extract';
import type { NotificationItem } from '@/shared/types';

export const notificationService = {
  async list(): Promise<{ notifications: NotificationItem[]; unreadCount: number }> {
    const res = await api.get('/notifications');
    return extractData<{ notifications: NotificationItem[]; unreadCount: number }>(res);
  },

  async markRead(id: string): Promise<void> {
    await api.post(`/notifications/${id}/read`);
  },

  async markAllRead(): Promise<void> {
    await api.post('/notifications/read-all');
  },
};
