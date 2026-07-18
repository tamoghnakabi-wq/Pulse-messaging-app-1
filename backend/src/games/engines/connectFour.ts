import type {
  ActionResult,
  CreateGameOptions,
  EngineContext,
  EngineState,
  GameEngine,
  GamePlayerSnap,
} from '../types';
import { GameRuleError } from '../types';

const ROWS = 6;
const COLS = 7;

type Grid = (string | null)[][];

function emptyGrid(): Grid {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

function drop(grid: Grid, col: number, mark: string): number {
  for (let r = ROWS - 1; r >= 0; r--) {
    if (grid[r][col] == null) {
      grid[r][col] = mark;
      return r;
    }
  }
  return -1;
}

function countDir(
  grid: Grid,
  r: number,
  c: number,
  dr: number,
  dc: number,
  mark: string
): number {
  let n = 0;
  let rr = r + dr;
  let cc = c + dc;
  while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && grid[rr][cc] === mark) {
    n++;
    rr += dr;
    cc += dc;
  }
  return n;
}

function isWin(grid: Grid, r: number, c: number, mark: string): boolean {
  const dirs = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  for (const [dr, dc] of dirs) {
    const total =
      1 + countDir(grid, r, c, dr, dc, mark) + countDir(grid, r, c, -dr, -dc, mark);
    if (total >= 4) return true;
  }
  return false;
}

function isFull(grid: Grid): boolean {
  return grid[0].every((c) => c != null);
}

export const connectFourEngine: GameEngine = {
  type: 'connect_four',
  displayName: 'Connect Four',
  icon: '🔴',
  description: 'Drop discs — connect four in a row to win.',
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
    return { grid: emptyGrid(), marks: {} as Record<string, string> };
  },

  canJoin(ctx, userId) {
    if (ctx.status !== 'invited') return false;
    if (ctx.players.some((p) => p.userId === userId && p.status === 'joined')) return false;
    return ctx.players.filter((p) => p.status === 'joined').length < 2;
  },

  onJoin(ctx, userId) {
    const players = ctx.players.map((p) =>
      p.userId === userId ? { ...p, status: 'joined' as const } : { ...p }
    );
    const joined = players.filter((p) => p.status === 'joined').sort((a, b) => a.order - b.order);
    const marks: Record<string, string> = {};
    if (joined[0]) {
      joined[0].symbol = 'R';
      marks[joined[0].userId] = 'R';
    }
    if (joined[1]) {
      joined[1].symbol = 'Y';
      marks[joined[1].userId] = 'Y';
    }
    return {
      players,
      state: { grid: (ctx.state.grid as Grid) || emptyGrid(), marks },
    };
  },

  canStart(ctx) {
    return ctx.players.filter((p) => p.status === 'joined').length === 2;
  },

  start(ctx) {
    const joined = ctx.players
      .filter((p) => p.status === 'joined')
      .sort((a, b) => a.order - b.order);
    const marks: Record<string, string> = {
      [joined[0].userId]: 'R',
      [joined[1].userId]: 'Y',
    };
    joined[0].symbol = 'R';
    joined[1].symbol = 'Y';
    return {
      state: { grid: emptyGrid(), marks },
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
    const col = Number(action.column);
    if (!Number.isInteger(col) || col < 0 || col >= COLS) {
      throw new GameRuleError('Invalid column', 'INVALID_MOVE');
    }
    const prev = (ctx.state.grid as Grid) || emptyGrid();
    const grid = prev.map((row) => [...row]);
    const marks = (ctx.state.marks as Record<string, string>) || {};
    const mark = marks[userId];
    if (!mark) throw new GameRuleError('Not a player', 'NOT_PLAYER');
    const row = drop(grid, col, mark);
    if (row < 0) throw new GameRuleError('Column full', 'INVALID_MOVE');

    const players = ctx.players.map((p) => ({ ...p }));
    let completed = false;
    let winnerIds: string[] = [];
    let isDraw = false;
    let currentTurnUserId: string | null = null;

    if (isWin(grid, row, col, mark)) {
      completed = true;
      winnerIds = [userId];
      const w = players.find((p) => p.userId === userId);
      if (w) w.score = (w.score || 0) + 1;
    } else if (isFull(grid)) {
      completed = true;
      isDraw = true;
    } else {
      const other = players.find((p) => p.status === 'joined' && p.userId !== userId);
      currentTurnUserId = other?.userId || null;
    }

    return {
      state: { grid, marks, lastMove: { row, col, mark } },
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
