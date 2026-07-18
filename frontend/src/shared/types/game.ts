export type GameTypeId =
  | 'tic_tac_toe'
  | 'connect_four'
  | 'trivia_duel'
  | 'emoji_guess';

export type GameStatus =
  | 'invited'
  | 'active'
  | 'completed'
  | 'declined'
  | 'cancelled'
  | 'expired';

export interface GamePlayer {
  userId: string;
  user?: {
    id: string;
    username?: string;
    displayName?: string;
    avatar?: string;
  } | string;
  status: 'invited' | 'joined' | 'declined' | 'left';
  score: number;
  order: number;
  symbol?: string;
}

export interface PulseGame {
  id: string;
  conversation: string;
  gameType: GameTypeId;
  displayName: string;
  icon: string;
  status: GameStatus;
  creator: { id: string; username?: string; displayName?: string; avatar?: string } | string;
  creatorId: string;
  players: GamePlayer[];
  state: Record<string, unknown>;
  options: Record<string, unknown>;
  currentTurnUserId?: string | null;
  winnerIds: string[];
  isDraw: boolean;
  version: number;
  rematchOf?: string | null;
  startedAt?: string;
  completedAt?: string;
  expiresAt?: string;
  inviteMessageId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** Server-managed — not E2E encrypted */
  serverAuthoritative?: boolean;
  notE2E?: boolean;
}

export interface GameCatalogItem {
  type: GameTypeId;
  displayName: string;
  icon: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
}

export interface LeaderboardRow {
  rank: number;
  user: { id: string; username?: string; displayName?: string; avatar?: string };
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  currentStreak: number;
  bestStreak: number;
}
