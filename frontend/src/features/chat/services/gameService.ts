import api from '@/shared/api/client';
import { extractData } from '@/shared/api/extract';
import type {
  GameCatalogItem,
  LeaderboardRow,
  PulseGame,
} from '@/shared/types/game';

export const gameService = {
  async catalog(): Promise<GameCatalogItem[]> {
    const res = await api.get('/games/catalog');
    return extractData<{ games: GameCatalogItem[] }>(res).games;
  },

  async create(
    conversationId: string,
    gameType: string,
    options?: Record<string, unknown>,
    inviteUserIds?: string[]
  ): Promise<PulseGame> {
    const res = await api.post(`/games/conversation/${conversationId}`, {
      gameType,
      options: options || {},
      inviteUserIds,
    });
    return extractData<{ game: PulseGame }>(res).game;
  },

  async get(id: string): Promise<PulseGame> {
    const res = await api.get(`/games/${id}`);
    return extractData<{ game: PulseGame }>(res).game;
  },

  async list(conversationId: string, limit = 30): Promise<PulseGame[]> {
    const res = await api.get(`/games/conversation/${conversationId}`, {
      params: { limit },
    });
    return extractData<{ games: PulseGame[] }>(res).games;
  },

  async join(id: string): Promise<PulseGame> {
    const res = await api.post(`/games/${id}/join`);
    return extractData<{ game: PulseGame }>(res).game;
  },

  async decline(id: string): Promise<PulseGame> {
    const res = await api.post(`/games/${id}/decline`);
    return extractData<{ game: PulseGame }>(res).game;
  },

  async cancel(id: string): Promise<PulseGame> {
    const res = await api.post(`/games/${id}/cancel`);
    return extractData<{ game: PulseGame }>(res).game;
  },

  async start(id: string): Promise<PulseGame> {
    const res = await api.post(`/games/${id}/start`);
    return extractData<{ game: PulseGame }>(res).game;
  },

  async action(
    id: string,
    action: Record<string, unknown>,
    opts?: { clientActionId?: string; expectedVersion?: number }
  ): Promise<PulseGame> {
    const res = await api.post(`/games/${id}/action`, {
      action,
      clientActionId: opts?.clientActionId,
      expectedVersion: opts?.expectedVersion,
    });
    return extractData<{ game: PulseGame }>(res).game;
  },

  async rematch(id: string): Promise<PulseGame> {
    const res = await api.post(`/games/${id}/rematch`);
    return extractData<{ game: PulseGame }>(res).game;
  },

  async leaderboard(conversationId: string): Promise<LeaderboardRow[]> {
    const res = await api.get(`/games/conversation/${conversationId}/leaderboard`);
    return extractData<{ leaderboard: LeaderboardRow[] }>(res).leaderboard;
  },

  async myStats(conversationId?: string) {
    const res = await api.get('/games/stats/me', {
      params: conversationId ? { conversationId } : undefined,
    });
    return extractData<{ stats: Record<string, unknown> }>(res).stats;
  },
};
