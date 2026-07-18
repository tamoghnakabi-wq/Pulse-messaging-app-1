import { normalizeGuess, pickEmojiRiddles, type EmojiRiddle } from '../emojiBank';
import type {
  ActionResult,
  CreateGameOptions,
  EngineContext,
  EngineState,
  GameEngine,
  GamePlayerSnap,
} from '../types';
import { GameRuleError } from '../types';

/** How long the correct answer stays visible before the next round (ms) */
const REVEAL_MS = 2800;

interface EmojiRound {
  index: number;
  riddleId: string;
  emoji: string;
  hint?: string;
  endsAt: number;
  guesses: Record<string, string>;
  solvedBy?: string;
  revealed: boolean;
  answerReveal?: string;
  scored?: boolean;
  revealEndsAt?: number;
}

function riddles(state: EngineState): EmojiRiddle[] {
  return (state.riddles as EmojiRiddle[]) || [];
}

function advance(
  state: EngineState,
  players: GamePlayerSnap[],
  turnSeconds: number,
  now: number
): { state: EngineState; completed: boolean; winnerIds: string[]; isDraw: boolean } {
  const list = riddles(state);
  const idx = Number(state.roundIndex || 0) + 1;
  if (idx >= list.length) {
    const max = Math.max(...players.map((p) => p.score || 0), 0);
    const winners = players.filter((p) => (p.score || 0) === max && max > 0).map((p) => p.userId);
    const allZero = players.every((p) => !p.score);
    const multiWin = winners.length > 1;
    return {
      state: { ...state, roundIndex: idx, round: null, phase: 'done' },
      completed: true,
      winnerIds: allZero || multiWin ? [] : winners,
      isDraw: allZero || multiWin,
    };
  }
  const r = list[idx];
  const round: EmojiRound = {
    index: idx,
    riddleId: r.id,
    emoji: r.emoji,
    hint: r.hint,
    endsAt: now + turnSeconds * 1000,
    guesses: {},
    revealed: false,
    scored: false,
  };
  return {
    state: { ...state, roundIndex: idx, round, phase: 'guess' },
    completed: false,
    winnerIds: [],
    isDraw: false,
  };
}

function resolveRound(
  state: EngineState,
  players: GamePlayerSnap[],
  turnSeconds: number,
  now: number
): ActionResult {
  const round = state.round as EmojiRound | null;
  if (!round) {
    return {
      state,
      players,
      currentTurnUserId: null,
      completed: state.phase === 'done',
      winnerIds: [],
      isDraw: false,
      event: 'noop',
    };
  }
  // Reveal window → then advance
  if (round.scored && round.revealed) {
    const revealEnds = round.revealEndsAt ?? 0;
    if (now < revealEnds) {
      return {
        state,
        players,
        currentTurnUserId: null,
        completed: false,
        winnerIds: [],
        isDraw: false,
        event: 'reveal',
      };
    }
    const adv = advance(state, players, turnSeconds, now);
    return {
      state: adv.state,
      players,
      currentTurnUserId: null,
      completed: adv.completed,
      winnerIds: adv.winnerIds,
      isDraw: adv.isDraw,
      event: adv.completed ? 'complete' : 'round',
    };
  }
  const list = riddles(state);
  const r = list[round.index];
  return {
    state: {
      ...state,
      phase: 'reveal',
      round: {
        ...round,
        revealed: true,
        scored: true,
        answerReveal: r?.answers[0],
        revealEndsAt: now + REVEAL_MS,
      },
    },
    players,
    currentTurnUserId: null,
    completed: false,
    winnerIds: [],
    isDraw: false,
    event: 'reveal',
  };
}

export const emojiGuessEngine: GameEngine = {
  type: 'emoji_guess',
  displayName: 'Emoji Guess',
  icon: '😎',
  description: 'Decode the emoji riddle before time runs out.',
  minPlayers: 2,
  maxPlayers: 12,
  inviteTtlMs: 30 * 60 * 1000,
  activeTtlMs: 60 * 60 * 1000,

  validateOptions(opts) {
    return {
      maxPlayers: Math.min(12, Math.max(2, opts.maxPlayers || 8)),
      rounds: Math.min(10, Math.max(3, opts.rounds || 5)),
      turnSeconds: Math.min(60, Math.max(10, opts.turnSeconds || 25)),
    };
  },

  createInitialState(opts) {
    const seed = `emoji-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return {
      seed,
      riddles: pickEmojiRiddles(opts.rounds || 5, seed),
      roundIndex: -1,
      round: null,
      phase: 'lobby',
      turnSeconds: opts.turnSeconds || 25,
    };
  },

  canJoin(ctx, userId) {
    if (ctx.status !== 'invited') return false;
    if (ctx.players.some((p) => p.userId === userId && p.status === 'joined')) return false;
    const max = ctx.options.maxPlayers || this.maxPlayers;
    return ctx.players.filter((p) => p.status === 'joined').length < max;
  },

  onJoin(ctx, userId) {
    return {
      players: ctx.players.map((p) =>
        p.userId === userId ? { ...p, status: 'joined' as const } : { ...p }
      ),
      state: ctx.state,
    };
  },

  canStart(ctx) {
    return ctx.players.filter((p) => p.status === 'joined').length >= this.minPlayers;
  },

  start(ctx) {
    const now = ctx.now.getTime();
    const turnSeconds = Number(ctx.state.turnSeconds || 25);
    const base = { ...ctx.state, roundIndex: -1, phase: 'guess' };
    const next = advance(base, ctx.players, turnSeconds, now);
    return {
      state: next.state,
      players: ctx.players,
      currentTurnUserId: null,
    };
  },

  applyAction(ctx, userId, action): ActionResult {
    if (ctx.status !== 'active') throw new GameRuleError('Game is not active', 'GAME_NOT_ACTIVE');
    const player = ctx.players.find((p) => p.userId === userId && p.status === 'joined');
    if (!player) throw new GameRuleError('Not a player', 'NOT_PLAYER');

    const kind = String(action.type || action.kind || 'guess');
    const now = ctx.now.getTime();
    let state = { ...ctx.state };
    let players = ctx.players.map((p) => ({ ...p }));
    const turnSeconds = Number(state.turnSeconds || 25);
    const round = state.round as EmojiRound | null;

    if (kind === 'tick' || kind === 'resolve') {
      if (!round) {
        return {
          state,
          players,
          currentTurnUserId: null,
          completed: state.phase === 'done',
          winnerIds: [],
          isDraw: false,
          event: 'noop',
        };
      }
      if (round.scored && round.revealed) {
        return resolveRound(state, players, turnSeconds, now);
      }
      if (now < round.endsAt) {
        throw new GameRuleError('Round is still in progress', 'ROUND_NOT_ENDED', 400);
      }
      return resolveRound(state, players, turnSeconds, now);
    }

    if (kind !== 'guess') throw new GameRuleError('Unknown action', 'INVALID_ACTION');
    if (!round || round.revealed || round.scored) {
      throw new GameRuleError('No active riddle', 'NO_QUESTION');
    }
    if (now > round.endsAt) throw new GameRuleError('Time is up', 'EXPIRED');
    const prevGuesses = round.guesses || {};
    if (prevGuesses[userId] !== undefined) {
      throw new GameRuleError('Already guessed this round', 'DUPLICATE_ANSWER');
    }

    const guess = normalizeGuess(String(action.guess || action.text || ''));
    if (!guess || guess.length > 80) throw new GameRuleError('Invalid guess', 'INVALID_MOVE');

    const list = riddles(state);
    const r = list[round.index];
    if (!r) throw new GameRuleError('Riddle missing', 'INTERNAL');

    const guesses = { ...prevGuesses, [userId]: guess };
    const correct = r.answers.some((a) => normalizeGuess(a) === guess);

    if (correct) {
      players = players.map((p) =>
        p.userId === userId ? { ...p, score: (p.score || 0) + 1 } : p
      );
      // Enter reveal window so clients can show the answer before next riddle
      return {
        state: {
          ...state,
          phase: 'reveal',
          round: {
            ...round,
            guesses,
            solvedBy: userId,
            revealed: true,
            scored: true,
            answerReveal: r.answers[0],
            revealEndsAt: now + REVEAL_MS,
          },
        },
        players,
        currentTurnUserId: null,
        completed: false,
        winnerIds: [],
        isDraw: false,
        event: 'solved',
      };
    }

    state = { ...state, round: { ...round, guesses } };
    return {
      state,
      players,
      currentTurnUserId: null,
      completed: false,
      winnerIds: [],
      isDraw: false,
      event: 'guess',
    };
  },

  sanitizeStateForClient(state, userId) {
    const round = state.round as EmojiRound | null;
    const guessed = round ? Object.keys(round.guesses || {}) : [];
    let safeRound: Record<string, unknown> | null = null;
    if (round) {
      safeRound = {
        index: round.index,
        riddleId: round.riddleId,
        emoji: round.emoji,
        hint: round.hint,
        endsAt: round.endsAt,
        revealed: !!round.revealed,
        answered: guessed,
        hasGuessed: guessed.includes(userId),
        solvedBy: round.solvedBy,
        revealEndsAt: round.revealEndsAt,
      };
      if (round.revealed || round.scored) {
        safeRound.answerReveal = round.answerReveal;
      }
    }
    return {
      phase: state.phase,
      turnSeconds: state.turnSeconds,
      roundIndex: state.roundIndex,
      totalRounds: riddles(state).length,
      round: safeRound,
      // Omit riddles queue, seed, answers
    };
  },
};
