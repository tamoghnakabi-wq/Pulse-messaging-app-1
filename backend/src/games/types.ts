/**
 * Pulse Play — game engine contracts.
 * Rule logic lives here (and in engines/*); controllers only authorize + persist.
 */

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

export type PlayerJoinStatus = 'invited' | 'joined' | 'declined' | 'left';

export interface GamePlayerSnap {
  userId: string;
  status: PlayerJoinStatus;
  score: number;
  order: number;
  symbol?: string;
  displayName?: string;
}

/** Opaque engine state — never trust client copies */
export type EngineState = Record<string, unknown>;

export interface CreateGameOptions {
  /** Max players override within engine limits */
  maxPlayers?: number;
  /** Trivia / emoji rounds */
  rounds?: number;
  /** Seconds per turn / question */
  turnSeconds?: number;
  /** Invite specific users (group); empty = open to conversation */
  inviteUserIds?: string[];
}

export interface EngineContext {
  gameType: GameTypeId;
  players: GamePlayerSnap[];
  state: EngineState;
  status: GameStatus;
  currentTurnUserId?: string | null;
  creatorId: string;
  options: CreateGameOptions;
  now: Date;
  version: number;
}

export interface ActionResult {
  state: EngineState;
  players: GamePlayerSnap[];
  currentTurnUserId?: string | null;
  completed: boolean;
  winnerIds: string[];
  isDraw: boolean;
  /** Public-safe event label for UI toasts */
  event?: string;
}

export interface GameEngine {
  readonly type: GameTypeId;
  readonly displayName: string;
  readonly icon: string;
  readonly description: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  /** Default invite expiry ms */
  readonly inviteTtlMs: number;
  /** Default active game idle expiry ms */
  readonly activeTtlMs: number;

  validateOptions(opts: CreateGameOptions): CreateGameOptions;

  /** Build initial state when game is created (invited) */
  createInitialState(opts: CreateGameOptions, players: GamePlayerSnap[]): EngineState;

  /** Whether user may join from invited */
  canJoin(ctx: EngineContext, userId: string): boolean;

  /** Mutate players/state on join; return updated players */
  onJoin(ctx: EngineContext, userId: string): { players: GamePlayerSnap[]; state: EngineState };

  canStart(ctx: EngineContext): boolean;

  /** Transition to active; set first turn */
  start(ctx: EngineContext): {
    state: EngineState;
    players: GamePlayerSnap[];
    currentTurnUserId: string | null;
  };

  /**
   * Apply a player action. Must throw Error with code-friendly message on invalid.
   * Never trust client board/scores — recompute from prior state + action.
   */
  applyAction(
    ctx: EngineContext,
    userId: string,
    action: Record<string, unknown>
  ): ActionResult;

  /**
   * Strip secrets (correct answers) before sending to a given user.
   * After a round is resolved, answers may be revealed.
   */
  sanitizeStateForClient(state: EngineState, userId: string, ctx: EngineContext): EngineState;
}

export class GameRuleError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = 'GAME_RULE', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
