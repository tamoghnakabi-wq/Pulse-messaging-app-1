import { pickTriviaQuestions, type TriviaQuestion } from '../triviaBank';
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

interface RoundState {
  index: number;
  questionId: string;
  category: string;
  prompt: string;
  choices: string[];
  endsAt: number;
  answers: Record<string, number>;
  revealed: boolean;
  correctIndex?: number;
  /** Prevent double-scoring when resolve is replayed */
  scored?: boolean;
  /** Server time when reveal window ends and advance is allowed */
  revealEndsAt?: number;
}

function loadQuestions(state: EngineState): TriviaQuestion[] {
  return (state.questions as TriviaQuestion[]) || [];
}

function currentRound(state: EngineState): RoundState | null {
  return (state.round as RoundState) || null;
}

function advanceRound(
  state: EngineState,
  players: GamePlayerSnap[],
  turnSeconds: number,
  now: number
): { state: EngineState; completed: boolean; winnerIds: string[]; isDraw: boolean } {
  const qs = loadQuestions(state);
  const idx = Number(state.roundIndex || 0) + 1;
  if (idx >= qs.length) {
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
  const q = qs[idx];
  const round: RoundState = {
    index: idx,
    questionId: q.id,
    category: q.category,
    prompt: q.prompt,
    choices: [...q.choices],
    endsAt: now + turnSeconds * 1000,
    answers: {},
    revealed: false,
    scored: false,
  };
  return {
    state: {
      ...state,
      roundIndex: idx,
      round,
      phase: 'question',
    },
    completed: false,
    winnerIds: [],
    isDraw: false,
  };
}

function scoreRound(state: EngineState, players: GamePlayerSnap[]): GamePlayerSnap[] {
  const qs = loadQuestions(state);
  const round = currentRound(state);
  if (!round || round.scored) return players;
  const q = qs[round.index];
  if (!q) return players;
  const answers = round.answers || {};
  return players.map((p) => {
    if (p.status !== 'joined') return p;
    const ans = answers[p.userId];
    if (ans === q.correctIndex) {
      return { ...p, score: (p.score || 0) + 1 };
    }
    return { ...p };
  });
}

/**
 * Resolve / advance current round (server clock authoritative).
 * - First call after deadline (or all answered): score + enter reveal window (UI can show answer).
 * - Second call after revealEndsAt: advance to next round or complete.
 * - Duplicate calls during reveal: idempotent no-op (no double score).
 */
function resolveCurrentRound(
  state: EngineState,
  players: GamePlayerSnap[],
  turnSeconds: number,
  now: number
): ActionResult {
  const round = currentRound(state);
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

  // Already scored: wait for reveal window, then advance
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
    const adv = advanceRound(state, players, turnSeconds, now);
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

  // First resolve: score once, stay on this round for REVEAL_MS
  const qs = loadQuestions(state);
  const q = qs[round.index];
  const nextPlayers = scoreRound(state, players);
  const revealedRound: RoundState = {
    ...round,
    answers: { ...(round.answers || {}) },
    revealed: true,
    scored: true,
    correctIndex: q?.correctIndex,
    revealEndsAt: now + REVEAL_MS,
  };
  return {
    state: { ...state, round: revealedRound, phase: 'reveal' },
    players: nextPlayers,
    currentTurnUserId: null,
    completed: false,
    winnerIds: [],
    isDraw: false,
    event: 'reveal',
  };
}

export const triviaDuelEngine: GameEngine = {
  type: 'trivia_duel',
  displayName: 'Trivia Duel',
  icon: '🧠',
  description: 'Timed multiple-choice rounds — first to the top of the board wins.',
  minPlayers: 2,
  maxPlayers: 8,
  inviteTtlMs: 30 * 60 * 1000,
  activeTtlMs: 60 * 60 * 1000,

  validateOptions(opts) {
    const maxPlayers = Math.min(8, Math.max(2, opts.maxPlayers || 4));
    const rounds = Math.min(10, Math.max(3, opts.rounds || 5));
    const turnSeconds = Math.min(60, Math.max(8, opts.turnSeconds || 20));
    return { maxPlayers, rounds, turnSeconds };
  },

  createInitialState(opts) {
    const seed = `trivia-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const questions = pickTriviaQuestions(opts.rounds || 5, seed);
    return {
      seed,
      questions,
      roundIndex: -1,
      round: null,
      phase: 'lobby',
      turnSeconds: opts.turnSeconds || 20,
    };
  },

  canJoin(ctx, userId) {
    if (ctx.status !== 'invited') return false;
    if (ctx.players.some((p) => p.userId === userId && p.status === 'joined')) return false;
    const max = ctx.options.maxPlayers || this.maxPlayers;
    return ctx.players.filter((p) => p.status === 'joined').length < max;
  },

  onJoin(ctx, userId) {
    const players = ctx.players.map((p) =>
      p.userId === userId ? { ...p, status: 'joined' as const } : { ...p }
    );
    return { players, state: ctx.state };
  },

  canStart(ctx) {
    return ctx.players.filter((p) => p.status === 'joined').length >= this.minPlayers;
  },

  start(ctx) {
    const now = ctx.now.getTime();
    const turnSeconds = Number(ctx.state.turnSeconds || ctx.options.turnSeconds || 20);
    const base = {
      ...ctx.state,
      roundIndex: -1,
      phase: 'question',
    };
    const next = advanceRound(base, ctx.players, turnSeconds, now);
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

    const kind = String(action.type || action.kind || 'answer');
    const now = ctx.now.getTime();
    let state = { ...ctx.state };
    let players = ctx.players.map((p) => ({ ...p }));
    const turnSeconds = Number(state.turnSeconds || 20);

    if (kind === 'tick' || kind === 'resolve') {
      const round = currentRound(state);
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
      // During reveal window: only advance after revealEndsAt (idempotent before that)
      if (round.scored && round.revealed) {
        return resolveCurrentRound(state, players, turnSeconds, now);
      }
      // Server clock is authoritative — reject early resolve of open round
      if (now < round.endsAt) {
        throw new GameRuleError('Round is still in progress', 'ROUND_NOT_ENDED', 400);
      }
      return resolveCurrentRound(state, players, turnSeconds, now);
    }

    if (kind !== 'answer') throw new GameRuleError('Unknown action', 'INVALID_ACTION');

    const round = currentRound(state);
    if (!round || round.revealed || round.scored) {
      throw new GameRuleError('No active question', 'NO_QUESTION');
    }
    if (now > round.endsAt) {
      throw new GameRuleError('Time is up', 'EXPIRED');
    }
    const prevAnswers = round.answers || {};
    if (prevAnswers[userId] !== undefined) {
      throw new GameRuleError('Already answered', 'DUPLICATE_ANSWER');
    }
    const choice = Number(action.choice ?? action.answer);
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) {
      throw new GameRuleError('Invalid choice', 'INVALID_MOVE');
    }
    const answers = { ...prevAnswers, [userId]: choice };
    state = { ...state, round: { ...round, answers } };

    // Everyone answered → resolve immediately (all-in is not early clock resolve)
    const joinedIds = players.filter((p) => p.status === 'joined').map((p) => p.userId);
    const allIn = joinedIds.every((id) => answers[id] !== undefined);
    if (allIn) {
      return resolveCurrentRound(state, players, turnSeconds, now);
    }

    return {
      state,
      players,
      currentTurnUserId: null,
      completed: false,
      winnerIds: [],
      isDraw: false,
      event: 'answer',
    };
  },

  sanitizeStateForClient(state, userId) {
    // Server keeps full `questions` + seed for resume; clients only get current round
    const round = currentRound(state);
    const answered = round ? Object.keys(round.answers ?? {}) : [];
    let safeRound: Record<string, unknown> | null = null;
    if (round) {
      safeRound = {
        index: round.index,
        questionId: round.questionId,
        category: round.category,
        prompt: round.prompt,
        choices: round.choices,
        endsAt: round.endsAt,
        revealed: !!round.revealed,
        answered,
        hasAnswered: answered.includes(userId),
        revealEndsAt: round.revealEndsAt,
      };
      if (round.revealed || round.scored) {
        safeRound.correctIndex = round.correctIndex;
      }
    }
    return {
      phase: state.phase,
      turnSeconds: state.turnSeconds,
      roundIndex: state.roundIndex,
      totalRounds: loadQuestions(state).length,
      round: safeRound,
      // Explicitly omit questions, seed, answer keys
    };
  },
};
