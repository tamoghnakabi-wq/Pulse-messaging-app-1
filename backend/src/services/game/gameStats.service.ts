import { Types } from 'mongoose';
import { GameStats } from '../../models/GameStats';
import { GameStatEvent } from '../../models/GameStatEvent';
import type { IGame } from '../../models/Game';

/** Stable string id from ObjectId / populated user / string */
function idStr(v: unknown): string {
  if (v == null || v === '') return '';
  if (typeof v === 'string') return v;
  if (v instanceof Types.ObjectId) return v.toString();
  if (typeof v === 'object') {
    const o = v as { _id?: unknown; id?: unknown; toString?: () => string };
    if (typeof o.id === 'string' && /^[a-f0-9]{24}$/i.test(o.id)) return o.id;
    if (o._id != null && o._id !== v) return idStr(o._id);
    if (typeof o.toString === 'function') {
      const s = o.toString();
      if (s && s !== '[object Object]' && /^[a-f0-9]{24}$/i.test(s)) return s;
    }
  }
  return '';
}

function isDupKey(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

/**
 * Apply one (game, user, scope) stats effect exactly once.
 *
 * Crash-safety model (single-document atomic claim):
 * 1. If a legacy GameStatEvent already exists for this effect, treat counters as
 *    already applied (old code wrote ledger first). Only ensure appliedGameIds.
 * 2. Otherwise atomically $inc counters + $addToSet appliedGameIds when the game
 *    is not yet in appliedGameIds. Crash mid-write is all-or-nothing per doc.
 * 3. Write GameStatEvent after the counter claim (audit / cross-process idempotency).
 *    Crash after (2) before (3): retry sees appliedGameIds and skips $inc; ledger
 *    is re-inserted or hits dup-key.
 *
 * Old bug: ledger create THEN $inc — crash between them caused permanent under-count
 * on retry (dup key → skip $inc forever).
 */
async function bumpOnce(
  gameId: string,
  userId: string,
  conversationId: string | undefined,
  patch: {
    result: 'win' | 'loss' | 'draw';
    gameType: string;
  }
): Promise<boolean> {
  if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(gameId)) return false;
  if (conversationId && !Types.ObjectId.isValid(conversationId)) return false;

  const scope = conversationId || 'global';
  const gameOid = new Types.ObjectId(gameId);
  const userOid = new Types.ObjectId(userId);
  const convKey = conversationId ? new Types.ObjectId(conversationId) : null;
  const filterBase = {
    user: userOid,
    conversation: convKey,
  };

  // ── Legacy path: ledger written before counters (pre-fix) ─────────────
  // Never $inc again for that effect; just mark appliedGameIds for consistency.
  const legacyLedger = await GameStatEvent.findOne({
    game: gameOid,
    user: userOid,
    scope,
  }).lean();
  if (legacyLedger) {
    await GameStats.updateOne(filterBase, {
      $addToSet: { appliedGameIds: gameOid },
      $setOnInsert: {
        user: userOid,
        conversation: convKey,
        gamesPlayed: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        currentStreak: 0,
        bestStreak: 0,
        byType: {},
        achievements: [],
        achievementEvents: [],
      },
    }, { upsert: true }).catch(async (err: unknown) => {
      if (!isDupKey(err)) throw err;
      await GameStats.updateOne(filterBase, { $addToSet: { appliedGameIds: gameOid } });
    });
    return false;
  }

  const inc: Record<string, number> = {
    gamesPlayed: 1,
  };
  if (patch.result === 'win') {
    inc.wins = 1;
    inc[`byType.${patch.gameType}.wins`] = 1;
  } else if (patch.result === 'loss') {
    inc.losses = 1;
    inc[`byType.${patch.gameType}.losses`] = 1;
  } else {
    inc.draws = 1;
    inc[`byType.${patch.gameType}.draws`] = 1;
  }
  inc[`byType.${patch.gameType}.played`] = 1;

  // ── Atomic claim: $inc only if this game not yet applied on this rollup ──
  const claimFilter = {
    ...filterBase,
    appliedGameIds: { $nin: [gameOid] },
  };
  const claimUpdate = {
    $inc: inc,
    $addToSet: { appliedGameIds: gameOid },
    $setOnInsert: {
      user: userOid,
      conversation: convKey,
      achievements: [] as string[],
      achievementEvents: [] as { code: string; at: Date; meta?: Record<string, unknown> }[],
      currentStreak: 0,
      bestStreak: 0,
    },
  };

  let appliedNow = false;
  try {
    const res = await GameStats.updateOne(claimFilter, claimUpdate, { upsert: true });
    appliedNow = (res.modifiedCount ?? 0) > 0 || (res.upsertedCount ?? 0) > 0;
  } catch (err: unknown) {
    // Concurrent first insert of same user+conversation unique index
    if (!isDupKey(err)) throw err;
    const res = await GameStats.updateOne(claimFilter, {
      $inc: inc,
      $addToSet: { appliedGameIds: gameOid },
    });
    appliedNow = (res.modifiedCount ?? 0) > 0;
  }

  // Already applied on a prior successful claim (retry after crash or lease reclaim)
  if (!appliedNow) {
    // Still ensure ledger exists for audit / legacy detectors
    try {
      await GameStatEvent.create({
        game: gameOid,
        user: userOid,
        scope,
        result: patch.result,
        gameType: patch.gameType,
      });
    } catch (err: unknown) {
      if (!isDupKey(err)) throw err;
    }
    return false;
  }

  // ── Audit ledger AFTER counters (crash here is safe: appliedGameIds already set) ──
  try {
    await GameStatEvent.create({
      game: gameOid,
      user: userOid,
      scope,
      result: patch.result,
      gameType: patch.gameType,
    });
  } catch (err: unknown) {
    if (!isDupKey(err)) throw err;
  }

  // Streak / achievements (best-effort after counters land; only when we just applied)
  const doc = await GameStats.findOne(filterBase);
  if (!doc) return true;

  if (patch.result === 'win') {
    doc.currentStreak = (doc.currentStreak || 0) + 1;
    doc.bestStreak = Math.max(doc.bestStreak || 0, doc.currentStreak);
  } else {
    doc.currentStreak = 0;
  }

  const events = [...(doc.achievementEvents || [])];
  const codes = new Set(doc.achievements || []);
  const unlock = (code: string) => {
    if (codes.has(code)) return;
    codes.add(code);
    events.push({ code, at: new Date(), meta: { gameType: patch.gameType } });
  };
  if ((doc.wins || 0) >= 1) unlock('first_win');
  if ((doc.wins || 0) >= 10) unlock('wins_10');
  if ((doc.gamesPlayed || 0) >= 1) unlock('first_game');
  if ((doc.bestStreak || 0) >= 3) unlock('streak_3');
  doc.achievements = [...codes];
  doc.achievementEvents = events.slice(-50);
  await doc.save();
  return true;
}

/**
 * Apply global + conversation stats for a completed game.
 * Idempotent via appliedGameIds + GameStatEvent — safe to call repeatedly.
 */
export async function recordGameCompletion(game: IGame): Promise<void> {
  if (game.status !== 'completed') return;
  const gameId = idStr(game._id);
  const convId = idStr(game.conversation);
  if (!gameId || !convId) return;

  const winners = new Set((game.winnerIds || []).map((w) => idStr(w)).filter(Boolean));
  const joined = (game.players || []).filter((p) => p.status === 'joined');

  for (const p of joined) {
    const uid = idStr(p.user);
    if (!uid) continue;
    let result: 'win' | 'loss' | 'draw' = 'loss';
    if (game.isDraw || winners.size === 0) result = 'draw';
    else if (winners.has(uid)) result = 'win';
    else result = 'loss';

    await bumpOnce(gameId, uid, undefined, { result, gameType: game.gameType });
    await bumpOnce(gameId, uid, convId, { result, gameType: game.gameType });
  }
}

export async function getUserStats(userId: string, conversationId?: string) {
  if (!Types.ObjectId.isValid(userId)) {
    return emptyStats(userId, conversationId);
  }
  const filter: Record<string, unknown> = {
    user: new Types.ObjectId(userId),
    conversation: conversationId ? new Types.ObjectId(conversationId) : null,
  };
  const doc = await GameStats.findOne(filter).lean();
  if (!doc) return emptyStats(userId, conversationId);
  const played = doc.gamesPlayed || 0;
  return {
    userId,
    conversationId: conversationId || null,
    gamesPlayed: played,
    wins: doc.wins || 0,
    losses: doc.losses || 0,
    draws: doc.draws || 0,
    winRate: played ? Math.round(((doc.wins || 0) / played) * 1000) / 10 : 0,
    currentStreak: doc.currentStreak || 0,
    bestStreak: doc.bestStreak || 0,
    byType: doc.byType || {},
    achievements: doc.achievements || [],
  };
}

function emptyStats(userId: string, conversationId?: string) {
  return {
    userId,
    conversationId: conversationId || null,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    winRate: 0,
    currentStreak: 0,
    bestStreak: 0,
    byType: {},
    achievements: [] as string[],
  };
}

export async function getConversationLeaderboard(conversationId: string, limit = 20) {
  if (!Types.ObjectId.isValid(conversationId)) return [];
  const rows = await GameStats.find({
    conversation: new Types.ObjectId(conversationId),
  })
    .sort({ wins: -1, gamesPlayed: -1 })
    .limit(Math.min(50, limit))
    .populate('user', 'username displayName avatar')
    .lean();

  return rows.map((r, i) => {
    const played = r.gamesPlayed || 0;
    const u = r.user as unknown as {
      _id?: Types.ObjectId;
      id?: string;
      username?: string;
      displayName?: string;
      avatar?: string;
    };
    return {
      rank: i + 1,
      user: {
        id: (typeof u?.id === 'string' ? u.id : '') || u?._id?.toString() || '',
        username: u?.username,
        displayName: u?.displayName,
        avatar: u?.avatar,
      },
      gamesPlayed: played,
      wins: r.wins || 0,
      losses: r.losses || 0,
      draws: r.draws || 0,
      winRate: played ? Math.round(((r.wins || 0) / played) * 1000) / 10 : 0,
      currentStreak: r.currentStreak || 0,
      bestStreak: r.bestStreak || 0,
    };
  });
}
