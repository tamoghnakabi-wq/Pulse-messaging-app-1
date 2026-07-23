import api from '@/services/api';
import { extractData } from '@/shared/api/extract';
import type { Message } from '@/shared/types';
import type { CreatePollInput, PulsePoll } from '@/shared/types/poll';

export const pollService = {
  async create(input: CreatePollInput): Promise<{ poll: PulsePoll; message: Message }> {
    const res = await api.post('/polls', input);
    return extractData<{ poll: PulsePoll; message: Message }>(res);
  },

  async get(pollId: string): Promise<PulsePoll> {
    const res = await api.get(`/polls/${pollId}`);
    const data = extractData<{ poll: PulsePoll }>(res);
    return data.poll;
  },

  async vote(pollId: string, optionIds: string[]): Promise<PulsePoll> {
    const res = await api.post(`/polls/${pollId}/vote`, { optionIds });
    const data = extractData<{ poll: PulsePoll }>(res);
    return data.poll;
  },

  async close(pollId: string): Promise<PulsePoll> {
    const res = await api.post(`/polls/${pollId}/close`);
    const data = extractData<{ poll: PulsePoll }>(res);
    return data.poll;
  },
};
