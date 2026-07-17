import api from '@/shared/api/client';
import { extractData } from '@/shared/api/extract';
import type { Message, User } from '@/shared/types';

export const userService = {
  async search(q: string): Promise<User[]> {
    const res = await api.get('/users/search', { params: { q } });
    return extractData<{ users: User[] }>(res).users;
  },

  async getById(id: string): Promise<User> {
    const res = await api.get(`/users/${id}`);
    return extractData<{ user: User }>(res).user;
  },

  async updateProfile(payload: {
    displayName?: string;
    bio?: string;
    username?: string;
  }): Promise<User> {
    const res = await api.patch('/users/me', payload);
    return extractData<{ user: User }>(res).user;
  },

  async updateSettings(settings: Record<string, unknown>) {
    const res = await api.patch('/users/me/settings', settings);
    return extractData<{ settings: unknown }>(res).settings;
  },

  async uploadAvatar(file: File): Promise<User> {
    const form = new FormData();
    form.append('avatar', file);
    const res = await api.post('/users/me/avatar', form);
    return extractData<{ user: User }>(res).user;
  },

  async uploadCoverPhoto(file: File): Promise<User> {
    const form = new FormData();
    form.append('cover', file);
    const res = await api.post('/users/me/cover', form);
    return extractData<{ user: User }>(res).user;
  },

  async removeCoverPhoto(): Promise<User> {
    const res = await api.delete('/users/me/cover');
    return extractData<{ user: User }>(res).user;
  },

  async changePassword(currentPassword: string, newPassword: string) {
    const res = await api.post('/users/me/password', { currentPassword, newPassword });
    return extractData(res);
  },

  async listStarredMessages(): Promise<Message[]> {
    const res = await api.get('/users/starred');
    return extractData<{ messages: Message[] }>(res).messages;
  },

  async listBlocked(): Promise<
    Array<{ id: string; username?: string; displayName?: string; avatar?: string }>
  > {
    const res = await api.get('/users/me/blocked');
    return extractData<{ blocked: Array<{ id: string; username?: string; displayName?: string; avatar?: string }> }>(
      res
    ).blocked;
  },

  async blockUser(userId: string) {
    const res = await api.post(`/users/me/blocked/${userId}`);
    return extractData(res);
  },

  async unblockUser(userId: string) {
    const res = await api.delete(`/users/me/blocked/${userId}`);
    return extractData(res);
  },

  async reportUser(userId: string, reason: string, details?: string) {
    const res = await api.post('/users/report', { userId, reason, details });
    return extractData(res);
  },
};
