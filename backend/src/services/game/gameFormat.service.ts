import { Types } from 'mongoose';
import type { IGame } from '../../models/Game';
import { getEngine } from '../../games/registry';
import type { GamePlayerSnap, EngineContext } from '../../games/types';

function idOf(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Types.ObjectId) return v.toString();
  if (typeof v === 'object') {
    const o = v as { _id?: unknown; id?: string; toString?: () => string };
    if (typeof o.id === 'string') return o.id;
    if (o._id) return idOf(o._id);
    if (typeof o.toString === 'function') {
      const s = o.toString();
      if (s && s !== '[object Object]') return s;
    }
  }
  return String(v);
}

function formatUserLite(u: unknown): Record<string, unknown> | string {
  if (!u) return '';
  if (typeof u === 'string') return u;
  if (typeof u === 'object') {
    const o = u as {
      _id?: unknown;
      id?: string;
      username?: string;
      displayName?: string;
      avatar?: string;
    };
    if (o.username || o.displayName) {
      return {
        id: o.id || idOf(o._id),
        username: o.username,
        displayName: o.displayName,
        avatar: o.avatar,
      };
    }
    return idOf(o._id || o);
  }
  return String(u);
}

export function playersToSnap(game: IGame): GamePlayerSnap[] {
  return (game.players || []).map((p, i) => ({
    userId: idOf(p.user),
    status: p.status,
    score: p.score || 0,
    order: p.order ?? i,
    symbol: p.symbol,
  }));
}

export function formatGame(
  game: IGame | Record<string, unknown>,
  viewerId?: string
): Record<string, unknown> {
  const raw =
    typeof (game as IGame).toObject === 'function'
      ? (game as IGame).toObject({ virtuals: true })
      : { ...(game as Record<string, unknown>) };

  const id = idOf((raw as { _id?: unknown })._id || (raw as { id?: string }).id);
  const gameType = String((raw as { gameType?: string }).gameType || '');
  let engine;
  try {
    engine = getEngine(gameType);
  } catch {
    engine = null;
  }

  const playersRaw = (raw as { players?: unknown[] }).players || [];
  const players = playersRaw.map((p) => {
    const pl = p as {
      user?: unknown;
      status?: string;
      score?: number;
      order?: number;
      symbol?: string;
    };
    return {
      user: formatUserLite(pl.user),
      userId: idOf(pl.user),
      status: pl.status,
      score: pl.score || 0,
      order: pl.order || 0,
      symbol: pl.symbol,
    };
  });

  const state = (raw as { state?: Record<string, unknown> }).state || {};
  let safeState = state;
  // Always sanitize (even without viewer) so future questions never leak
  if (engine) {
    const snap = players.map((p) => ({
      userId: p.userId,
      status: p.status as GamePlayerSnap['status'],
      score: p.score,
      order: p.order,
      symbol: p.symbol,
    }));
    const ctx: EngineContext = {
      gameType: engine.type,
      players: snap,
      state,
      status: (raw as { status?: EngineContext['status'] }).status || 'invited',
      currentTurnUserId: idOf((raw as { currentTurnUser?: unknown }).currentTurnUser) || null,
      creatorId: idOf((raw as { creator?: unknown }).creator),
      options: ((raw as { options?: Record<string, unknown> }).options || {}) as EngineContext['options'],
      now: new Date(),
      version: Number((raw as { version?: number }).version || 1),
    };
    safeState = engine.sanitizeStateForClient(state, viewerId || '', ctx);
  }

  return {
    id,
    conversation: idOf((raw as { conversation?: unknown }).conversation),
    gameType,
    displayName: engine?.displayName || gameType,
    icon: engine?.icon || '🎮',
    status: (raw as { status?: string }).status,
    creator: formatUserLite((raw as { creator?: unknown }).creator),
    creatorId: idOf((raw as { creator?: unknown }).creator),
    players,
    state: safeState,
    options: (raw as { options?: unknown }).options || {},
    currentTurnUserId: idOf((raw as { currentTurnUser?: unknown }).currentTurnUser) || null,
    winnerIds: ((raw as { winnerIds?: unknown[] }).winnerIds || []).map(idOf),
    isDraw: !!(raw as { isDraw?: boolean }).isDraw,
    version: Number((raw as { version?: number }).version || 1),
    rematchOf: idOf((raw as { rematchOf?: unknown }).rematchOf) || null,
    startedAt: (raw as { startedAt?: Date }).startedAt,
    completedAt: (raw as { completedAt?: Date }).completedAt,
    expiresAt: (raw as { expiresAt?: Date }).expiresAt,
    inviteMessageId: idOf((raw as { inviteMessage?: unknown }).inviteMessage) || null,
    createdAt: (raw as { createdAt?: Date }).createdAt,
    updatedAt: (raw as { updatedAt?: Date }).updatedAt,
    /** Server-managed activity — not E2E encrypted */
    serverAuthoritative: true,
    notE2E: true,
  };
}
