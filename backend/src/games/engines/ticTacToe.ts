import type {
  ActionResult,
  CreateGameOptions,
  EngineContext,
  EngineState,
  GameEngine,
  GamePlayerSnap,
} from '../types';
import { GameRuleError } from '../types';

type Board = (string | null)[];

function emptyBoard(): Board {
  return Array(9).fill(null);
}

function lines(): number[][] {
  return [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];
}

function winnerOf(board: Board): string | null {
  for (const [a, b, c] of lines()) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a] as string;
    }
  }
  return null;
}

function isFull(board: Board): boolean {
  return board.every((c) => c != null);
}

export const ticTacToeEngine: GameEngine = {
  type: 'tic_tac_toe',
  displayName: 'Tic-Tac-Toe',
  icon: '⭕',
  description: 'Classic 3×3 — first to three in a row wins.',
  minPlayers: 2,
  maxPlayers: 2,
  inviteTtlMs: 30 * 60 * 1000,
  activeTtlMs: 2 * 60 * 60 * 1000,

  validateOptions(opts) {
    return {
      maxPlayers: 2,
      turnSeconds: Math.min(300, Math.max(15, opts.turnSeconds || 120)),
    };
  },

  createInitialState() {
    return { board: emptyBoard(), marks: {} as Record<string, string> };
  },

  canJoin(ctx, userId) {
    if (ctx.status !== 'invited') return false;
    if (ctx.players.some((p) => p.userId === userId && p.status === 'joined')) return false;
    const joined = ctx.players.filter((p) => p.status === 'joined').length;
    return joined < 2;
  },

  onJoin(ctx, userId) {
    const players = ctx.players.map((p) =>
      p.userId === userId ? { ...p, status: 'joined' as const } : { ...p }
    );
    // Assign symbols to joined by order
    const joined = players.filter((p) => p.status === 'joined').sort((a, b) => a.order - b.order);
    const marks: Record<string, string> = {};
    if (joined[0]) {
      joined[0].symbol = 'X';
      marks[joined[0].userId] = 'X';
    }
    if (joined[1]) {
      joined[1].symbol = 'O';
      marks[joined[1].userId] = 'O';
    }
    return {
      players,
      state: { ...ctx.state, marks, board: (ctx.state.board as Board) || emptyBoard() },
    };
  },

  canStart(ctx) {
    return ctx.players.filter((p) => p.status === 'joined').length === 2;
  },

  start(ctx) {
    const joined = ctx.players
      .filter((p) => p.status === 'joined')
      .sort((a, b) => a.order - b.order);
    const marks: Record<string, string> = {};
    joined[0].symbol = 'X';
    joined[1].symbol = 'O';
    marks[joined[0].userId] = 'X';
    marks[joined[1].userId] = 'O';
    return {
      state: { board: emptyBoard(), marks },
      players: ctx.players.map((p) => {
        const j = joined.find((x) => x.userId === p.userId);
        return j ? { ...p, symbol: j.symbol } : p;
      }),
      currentTurnUserId: joined[0].userId,
    };
  },

  applyAction(ctx, userId, action): ActionResult {
    if (ctx.status !== 'active') throw new GameRuleError('Game is not active', 'GAME_NOT_ACTIVE');
    if (ctx.currentTurnUserId !== userId) {
      throw new GameRuleError('Not your turn', 'OUT_OF_TURN');
    }
    const cell = Number(action.cell);
    if (!Number.isInteger(cell) || cell < 0 || cell > 8) {
      throw new GameRuleError('Invalid cell', 'INVALID_MOVE');
    }
    const board = [...((ctx.state.board as Board) || emptyBoard())];
    if (board[cell] != null) throw new GameRuleError('Cell occupied', 'INVALID_MOVE');
    const marks = (ctx.state.marks as Record<string, string>) || {};
    const mark = marks[userId];
    if (!mark) throw new GameRuleError('Not a player', 'NOT_PLAYER');
    board[cell] = mark;

    const winMark = winnerOf(board);
    const players = ctx.players.map((p) => ({ ...p }));
    let completed = false;
    let winnerIds: string[] = [];
    let isDraw = false;
    let currentTurnUserId: string | null = null;

    if (winMark) {
      completed = true;
      const w = players.find((p) => p.symbol === winMark || marks[p.userId] === winMark);
      if (w) {
        winnerIds = [w.userId];
        w.score = (w.score || 0) + 1;
      }
    } else if (isFull(board)) {
      completed = true;
      isDraw = true;
    } else {
      const other = players.find(
        (p) => p.status === 'joined' && p.userId !== userId
      );
      currentTurnUserId = other?.userId || null;
    }

    return {
      state: { board, marks },
      players,
      currentTurnUserId,
      completed,
      winnerIds,
      isDraw,
      event: completed ? (isDraw ? 'draw' : 'win') : 'move',
    };
  },

  sanitizeStateForClient(state) {
    return state;
  },
};
