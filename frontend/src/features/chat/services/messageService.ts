import api from '@/shared/api/client';
import { extractData } from '@/shared/api/extract';
import type { MessagePage, SendMessagePayload, StarMessageResult } from '@/shared/api/types';
import type { Message } from '@/shared/types';

export const messageService = {
  async listByConversation(
    conversationId: string,
    params?: { limit?: number; before?: string }
  ): Promise<MessagePage> {
    const res = await api.get(`/messages/conversation/${conversationId}`, { params });
    return extractData<MessagePage>(res);
  },

  async send(
    conversationId: string,
    payload: SendMessagePayload,
    onProgress?: (pct: number) => void
  ): Promise<Message> {
    const form = new FormData();
    if (payload.content) form.append('content', payload.content);
    if (payload.type) form.append('type', payload.type);
    if (payload.replyTo) form.append('replyTo', payload.replyTo);
    if (payload.clientId) form.append('clientId', payload.clientId);
    if (payload.mentions) form.append('mentions', JSON.stringify(payload.mentions));
    if (payload.viewOnce) form.append('viewOnce', 'true');
    if (payload.isE2E) form.append('isE2E', 'true');
    if (payload.e2eMetas?.length) {
      form.append('e2eMetas', JSON.stringify(payload.e2eMetas));
    }
    if (payload.mediaTypes?.length) {
      form.append('mediaTypes', JSON.stringify(payload.mediaTypes));
    }
    payload.files?.forEach((f) => form.append('files', f));

    const res = await api.post(`/messages/conversation/${conversationId}`, form, {
      onUploadProgress: (e) => {
        if (e.total && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      },
    });
    return extractData<{ message: Message }>(res).message;
  },

  async edit(id: string, content: string, isE2E?: boolean): Promise<Message> {
    const res = await api.patch(`/messages/${id}`, { content, isE2E: !!isE2E });
    return extractData<{ message: Message }>(res).message;
  },

  async deleteForMe(id: string) {
    const res = await api.delete(`/messages/${id}/me`);
    return extractData(res);
  },

  async deleteForEveryone(id: string): Promise<Message> {
    const res = await api.delete(`/messages/${id}/everyone`);
    return extractData<{ message: Message }>(res).message;
  },

  /**
   * Open a view-once photo. Returns one-time media URLs; `locked` is the
   * message shape to keep in the store after viewing.
   */
  async openViewOnce(id: string): Promise<{
    message: Message;
    media: Array<{ url?: string; mimeType?: string; originalName?: string }>;
    locked: Message;
    alreadyOpened?: boolean;
  }> {
    const res = await api.post(`/messages/${id}/view-once`);
    return extractData(res);
  },

  async react(id: string, emoji: string): Promise<Message> {
    const res = await api.post(`/messages/${id}/react`, { emoji });
    return extractData<{ message: Message }>(res).message;
  },

  async forward(id: string, conversationIds: string[]): Promise<Message[]> {
    const res = await api.post(`/messages/${id}/forward`, { conversationIds });
    return extractData<{ messages: Message[] }>(res).messages;
  },

  async pin(id: string): Promise<Message> {
    const res = await api.post(`/messages/${id}/pin`);
    return extractData<{ message: Message }>(res).message;
  },

  async star(id: string): Promise<StarMessageResult> {
    const res = await api.post(`/messages/${id}/star`);
    return extractData<StarMessageResult>(res);
  },

  async search(q: string, conversationId?: string): Promise<Message[]> {
    const res = await api.get('/messages/search', {
      params: { q, conversationId },
    });
    return extractData<{ messages: Message[] }>(res).messages;
  },

  async listPinned(): Promise<Message[]> {
    const res = await api.get('/messages/pinned');
    return extractData<{ messages: Message[] }>(res).messages;
  },
};
