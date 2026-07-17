import api from '@/shared/api/client';
import { extractData } from '@/shared/api/extract';
import type {
  ConversationListFilter,
  ConversationPrefsUpdate,
} from '@/shared/api/types';
import type { Conversation } from '@/shared/types';

export const conversationService = {
  async list(filter: ConversationListFilter | string = 'all'): Promise<Conversation[]> {
    const res = await api.get('/conversations', { params: { filter } });
    return extractData<{ conversations: Conversation[] }>(res).conversations;
  },

  async getById(id: string): Promise<Conversation> {
    const res = await api.get(`/conversations/${id}`);
    return extractData<{ conversation: Conversation }>(res).conversation;
  },

  async createDirect(userId: string): Promise<Conversation> {
    const res = await api.post('/conversations/direct', { userId });
    return extractData<{ conversation: Conversation }>(res).conversation;
  },

  async createGroup(
    name: string,
    participantIds: string[],
    description?: string
  ): Promise<Conversation> {
    const res = await api.post('/conversations/group', {
      name,
      participantIds,
      description,
    });
    return extractData<{ conversation: Conversation }>(res).conversation;
  },

  async updateGroup(
    id: string,
    payload: { name?: string; description?: string }
  ): Promise<Conversation> {
    const res = await api.patch(`/conversations/${id}`, payload);
    return extractData<{ conversation: Conversation }>(res).conversation;
  },

  async updatePrefs(id: string, prefs: ConversationPrefsUpdate): Promise<Conversation> {
    const res = await api.patch(`/conversations/${id}/prefs`, prefs);
    return extractData<{ conversation: Conversation }>(res).conversation;
  },

  async markRead(id: string, messageId?: string) {
    const res = await api.post(`/conversations/${id}/read`, { messageId });
    return extractData(res);
  },

  async deleteGroup(id: string) {
    const res = await api.delete(`/conversations/${id}`);
    return extractData(res);
  },

  /** Soft-delete chat for the current user only (history hidden for them). */
  async deleteForMe(id: string) {
    const res = await api.delete(`/conversations/${id}/me`);
    return extractData<{ message: string; conversationId: string }>(res);
  },

  async addParticipants(id: string, userIds: string[]): Promise<Conversation> {
    const res = await api.post(`/conversations/${id}/participants`, { userIds });
    return extractData<{ conversation: Conversation }>(res).conversation;
  },

  async removeParticipant(id: string, userId: string): Promise<Conversation> {
    const res = await api.delete(`/conversations/${id}/participants/${userId}`);
    return extractData<{ conversation: Conversation }>(res).conversation;
  },
};
