import { api } from '@/shared/api/client';
import { extractData } from '@/shared/api/extract';
import type { CallHistoryItem } from '@/shared/types';

export const callService = {
  async getHistory(limit = 80): Promise<CallHistoryItem[]> {
    const res = await api.get('/calls/history', { params: { limit } });
    const data = extractData<{ items: CallHistoryItem[] }>(res);
    return Array.isArray(data?.items) ? data.items : [];
  },
};
