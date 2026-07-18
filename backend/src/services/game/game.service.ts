import { Types } from 'mongoose';
import { Game, type IGame } from '../../models/Game';
import { Message } from '../../models/Message';
import { Conversation } from '../../models/Conversation';
import { ensureConversationParticipant } from '../conversation/conversationAccess.service';
import { getEngine, listGameCatalog } from '../../games/registry';
import { GameRuleError, type CreateGameOptions, type GamePlayerSnap } from '../../games/types';
import { formatGame, playersToSnap } from './gameFormat.service';
import { recordGameCompletion } from './gameStats.service';
import { AppError } from '../../utils/AppError';
import { getIO } from '../../socket';
import { formatMessage } from '../../utils/messageFormat';
import { isObjectIdString } from '../../utils/sanitize';
import logger from '../../utils/logger';

function loggerWarnStats(err: unknown) {
  logger.warn('game stats update failed', {
    message: err instanceof Error ? err.message : String(err),
  });
}

/** Lease TTL — abandoned claims after a crash can be reclaimed */
const STATS_LEASE_MS = 2 * 60 * 1000;

/**
 * Recoverable stats lease:
 * 1. Atomically claim if not recorded and no active lease (or lease expired).
 * 2. Apply idempotent recordGameCompletion (appliedGameIds + ledger).
 * 3. On success: statsRecorded=true, clear lease.
 * 4. On failure: clear lease only (leave statsRecorded false) so retries work.
 * Crash after claim: lease expires and another worker reclaims;
 * appliedGameIds keeps counters exactly-once (ledger is audit + legacy guard).
 */
async function tryRecordStats(game: IGame): Promise<void> {
  if (game.status !== 'completed' || game.statsRecorded) return;

  const leaseExpiredBefore = new Date(Date.now() - STATS_LEASE_MS);
  const claimed = await Game.findOneAndUpdate(
    {
      _id: game._id,
      status: 'completed',
      statsRecorded: { $ne: true },
      $or: [
        { statsRecordingAt: null },
        { statsRecordingAt: { $exists: false } },
        { statsRecordingAt: { $lt: leaseExpiredBefore } },
      ],
    },
    { $set: { statsRecordingAt: new Date() } },
    { new: true }
  ).populate('players.user', 'username displayName avatar');

  if (!claimed) return;

  try {
    await recordGameCompletion(claimed);
    await Game.updateOne(
      { _id: claimed._id },
      { $set: { statsRecorded: true, statsRecordingAt: null } }
    );
  } catch (statsErr) {
    loggerWarnStats(statsErr);
    await Game.updateOne(
      { _id: claimed._id, statsRecorded: { $ne: true } },
      { $set: { statsRecordingAt: null } }
    );
  }
}

/**
 * Server-driven advance for timed games (trivia / emoji).
 * Resolves expired rounds and advances past reveal windows without a client.
 */
async function tickTimedGame(game: IGame): Promise<IGame | null> {
  if (game.status !== 'active') return null;
  if (game.gameType !== 'trivia_duel' && game.gameType !== 'emoji_guess') return null;
  const round = (game.state as { round?: { endsAt?: number; revealed?: boolean; scored?: boolean; revealEndsAt?: number } })
    ?.round;
  if (!round) return null;
  const now = Date.now();
  const needOpenResolve = !round.revealed && !round.scored && typeof round.endsAt === 'number' && now >= round.endsAt;
  const needAdvance =
    !!round.revealed &&
    !!round.scored &&
    typeof round.revealEndsAt === 'number' &&
    now >= round.revealEndsAt;
  if (!needOpenResolve && !needAdvance) return null;

  const snaps = playersToSnap(game);
  const actor = snaps.find((p) => p.status === 'joined')?.userId;
  if (!actor) return null;

  const expVer = Number(game.version || 1);
  const { engine, ctx } = engineCtx(game, new Date(now));
  let result;
  try {
    result = engine.applyAction(ctx, actor, { type: 'resolve' });
  } catch (err) {
    logger.warn('tickTimedGame applyAction failed', {
      gameId: String(game._id),
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof GameRuleError ? err.code : undefined,
      endsAt: round.endsAt,
      now,
      actor,
    });
    return null;
  }

  // No-op / still waiting
  if (result.event === 'noop' || result.event === 'reveal') {
    if (result.event === 'reveal' && !needAdvance && needOpenResolve === false) {
      // state may have entered reveal — persist if changed
    }
  }

  const playersPayload = result.players.map((s) => ({
    user: new Types.ObjectId(s.userId),
    status: s.status,
    score: s.score,
    order: s.order,
    symbol: s.symbol,
  }));
  const setDoc: Record<string, unknown> = {
    state: result.state,
    players: playersPayload,
    currentTurnUser: null,
  };
  if (result.completed) {
    setDoc.status = 'completed';
    setDoc.completedAt = new Date();
    setDoc.isDraw = result.isDraw;
    setDoc.winnerIds = result.winnerIds.map((id) => new Types.ObjectId(id));
  }

  const updated = await Game.findOneAndUpdate(
    { _id: game._id, version: expVer, status: 'active' },
    { $set: setDoc, $inc: { version: 1 } },
    { new: true }
  )
    .populate('creator', 'username displayName avatar')
    .populate('players.user', 'username displayName avatar');

  if (!updated) return null;

  if (result.completed && updated.status === 'completed') {
    await tryRecordStats(updated);
  }

  const dto = formatGame(updated);
  if (result.completed) {
    emitGame(uid(updated.conversation), 'game:completed', { game: dto });
  }
  emitGame(uid(updated.conversation), 'game:updated', { game: dto });
  return updated;
}

const CREATE_WINDOW_MS = 60_000;
const CREATE_MAX = 8;
const ACTION_WINDOW_MS = 10_000;
const ACTION_MAX = 40;
const createHits = new Map<string, { n: number; t: number }>();
const actionHits = new Map<string, { n: number; t: number }>();

function rateOk(map: Map<string, { n: number; t: number }>, key: string, windowMs: number, max: number) {
  const now = Date.now();
  const row = map.get(key);
  if (!row || now - row.t > windowMs) {
    map.set(key, { n: 1, t: now });
    return true;
  }
  if (row.n >= max) return false;
  row.n += 1;
  return true;
}

function uid(v: unknown): string {
  if (v == null || v === '') return '';
  if (typeof v === 'string') return v;
  if (v instanceof Types.ObjectId) return v.toString();
  if (typeof v === 'object') {
    const o = v as { _id?: unknown; id?: unknown; toString?: () => string };
    if (typeof o.id === 'string' && o.id.length === 24) return o.id;
    if (o._id != null && o._id !== v) return uid(o._id);
    if (typeof o.toString === 'function') {
      const s = o.toString();
      if (s && s !== '[object Object]' && /^[a-f0-9]{24}$/i.test(s)) return s;
    }
  }
  return String(v);
}

function emitGame(conversationId: string, event: string, payload: unknown) {
  try {
    getIO().to(`conversation:${conversationId}`).emit(event, payload);
  } catch {
    /* socket not ready */
  }
}

async function loadGame(gameId: string): Promise<IGame> {
  if (!isObjectIdString(gameId)) throw new AppError('Invalid game id', 400, 'INVALID_ID');
  const game = await Game.findById(gameId)
    .populate('creator', 'username displayName avatar')
    .populate('players.user', 'username displayName avatar');
  if (!game) throw new AppError('Game not found', 404, 'NOT_FOUND');
  return game;
}

async function maybeExpire(game: IGame): Promise<IGame> {
  if (game.status === 'completed' || game.status === 'cancelled' || game.status === 'declined') {
    return game;
  }
  if (game.expiresAt && game.expiresAt.getTime() < Date.now()) {
    game.status = 'expired';
    game.completedAt = new Date();
    await game.save();
    const dto = formatGame(game);
    emitGame(uid(game.conversation), 'game:expired', { game: dto });
    emitGame(uid(game.conversation), 'game:updated', { game: dto });
  }
  return game;
}

function engineCtx(game: IGame, now = new Date()) {
  const engine = getEngine(game.gameType);
  return {
    engine,
    ctx: {
      gameType: engine.type,
      players: playersToSnap(game),
      state: (game.state || {}) as Record<string, unknown>,
      status: game.status,
      currentTurnUserId: game.currentTurnUser ? uid(game.currentTurnUser) : null,
      creatorId: uid(game.creator),
      options: (game.options || {}) as CreateGameOptions,
      now,
      version: game.version || 1,
    },
  };
}

function applyPlayers(game: IGame, snaps: GamePlayerSnap[]) {
  const byId = new Map(snaps.map((s) => [s.userId, s]));
  game.players = game.players.map((p) => {
    const s = byId.get(uid(p.user));
    if (!s) return p;
    p.status = s.status;
    p.score = s.score;
    p.order = s.order;
    p.symbol = s.symbol;
    return p;
  });
  // New joins may add players not in snaps list with same users
  for (const s of snaps) {
    if (!game.players.some((p) => uid(p.user) === s.userId)) {
      game.players.push({
        user: new Types.ObjectId(s.userId),
        status: s.status,
        score: s.score,
        order: s.order,
        symbol: s.symbol,
      });
    }
  }
}

async function postSystemMessage(
  conversationId: string,
  senderId: string,
  content: string,
  gameId: string
) {
  const message = await Message.create({
    conversation: conversationId,
    sender: senderId,
    type: 'game',
    content,
    gameId,
    deliveredTo: [senderId],
    readBy: [{ user: senderId, readAt: new Date() }],
  });
  await Conversation.updateOne(
    { _id: conversationId },
    {
      $set: { lastMessage: message._id, lastMessageAt: message.createdAt },
      $inc: { 'participants.$[others].unreadCount': 1 },
    },
    { arrayFilters: [{ 'others.user': { $ne: new Types.ObjectId(senderId) } }] }
  );
  await message.populate('sender', 'username displayName avatar');
  const formatted = formatMessage(message);
  try {
    getIO().to(`conversation:${conversationId}`).emit('message:new', formatted);
  } catch {
    /* */
  }
  return message;
}

export const gameService = {
  catalog: listGameCatalog,

  async createInvitation(
    userId: string,
    conversationId: string,
    gameType: string,
    rawOptions: CreateGameOptions = {},
    inviteUserIds?: string[]
  ) {
    if (!rateOk(createHits, userId, CREATE_WINDOW_MS, CREATE_MAX)) {
      throw new AppError('Creating games too fast', 429, 'RATE_LIMIT');
    }
    const conv = await ensureConversationParticipant(conversationId, userId);
    const engine = getEngine(gameType);
    const options = engine.validateOptions(rawOptions || {});

    const participantIds = (conv.participants || []).map((p) => uid(p.user));
    const explicitInvites = (inviteUserIds || []).filter(
      (id) => isObjectIdString(id) && participantIds.includes(id) && id !== userId
    );
    // Open invite only for groups when no invite list was supplied
    const openInvite =
      conv.type === 'group' && (!inviteUserIds || inviteUserIds.length === 0);

    let inviteIds: string[] = explicitInvites;
    if (conv.type === 'direct') {
      // Direct chats always invite the peer (closed list)
      inviteIds = participantIds.filter((id) => id !== userId);
    } else if (!openInvite) {
      inviteIds = explicitInvites;
    } else {
      inviteIds = [];
    }

    const players: IGame['players'] = [
      {
        user: new Types.ObjectId(userId),
        status: 'joined',
        score: 0,
        order: 0,
      },
    ];
    let order = 1;
    for (const id of inviteIds.slice(0, (options.maxPlayers || engine.maxPlayers) - 1)) {
      players.push({
        user: new Types.ObjectId(id),
        status: 'invited',
        score: 0,
        order: order++,
      });
    }

    const snaps: GamePlayerSnap[] = players.map((p) => ({
      userId: uid(p.user),
      status: p.status,
      score: 0,
      order: p.order,
    }));
    const state = engine.createInitialState(options, snaps);
    const expiresAt = new Date(Date.now() + engine.inviteTtlMs);
    const optsWithInvite = { ...options, openInvite };

    const game = await Game.create({
      conversation: conv._id,
      gameType: engine.type,
      status: 'invited',
      creator: userId,
      players,
      state,
      options: optsWithInvite,
      openInvite,
      version: 1,
      processedActionIds: [],
      statsRecorded: false,
      expiresAt,
      winnerIds: [],
      isDraw: false,
    });

    const msg = await postSystemMessage(
      conversationId,
      userId,
      `🎮 ${engine.displayName} invitation`,
      game._id.toString()
    );
    game.inviteMessage = msg._id;
    await game.save();

    const populated = await loadGame(game._id.toString());
    const dto = formatGame(populated, userId);
    emitGame(conversationId, 'game:created', { game: dto });
    emitGame(conversationId, 'game:updated', { game: dto });
    return dto;
  },

  async getGame(userId: string, gameId: string) {
    let game = await loadGame(gameId);
    await ensureConversationParticipant(uid(game.conversation), userId);
    game = await maybeExpire(game);
    // Server-driven timers when a client polls / opens the card
    const ticked = await tickTimedGame(game);
    if (ticked) game = ticked;
    if (game.status === 'completed' && !game.statsRecorded) {
      await tryRecordStats(game);
      game = await loadGame(gameId);
    }
    return formatGame(game, userId);
  },

  async listConversationGames(userId: string, conversationId: string, limit = 30) {
    await ensureConversationParticipant(conversationId, userId);
    const games = await Game.find({ conversation: conversationId })
      .sort({ createdAt: -1 })
      .limit(Math.min(50, limit))
      .populate('creator', 'username displayName avatar')
      .populate('players.user', 'username displayName avatar');
    // expire lazy
    for (const g of games) {
      await maybeExpire(g);
    }
    return games.map((g) => formatGame(g, userId));
  },

  async join(userId: string, gameId: string) {
    if (!rateOk(actionHits, userId, ACTION_WINDOW_MS, ACTION_MAX)) {
      throw new AppError('Too many game actions', 429, 'RATE_LIMIT');
    }
    let game = await loadGame(gameId);
    await ensureConversationParticipant(uid(game.conversation), userId);
    game = await maybeExpire(game);
    if (game.status === 'expired') throw new AppError('Game expired', 410, 'GAME_EXPIRED');
    if (game.status !== 'invited') throw new AppError('Game is not open to join', 400, 'CANNOT_JOIN');

    const engine = getEngine(game.gameType);
    const max = (game.options as CreateGameOptions).maxPlayers || engine.maxPlayers;
    const openInvite =
      game.openInvite === true ||
      (game.options as { openInvite?: boolean })?.openInvite === true;
    const existing = game.players.find((p) => uid(p.user) === userId);
    if (existing?.status === 'joined') {
      return formatGame(game, userId);
    }
    // Closed invite: only creator + listed invitees
    if (!openInvite && !existing) {
      throw new AppError('You were not invited to this game', 403, 'NOT_INVITED');
    }
    if (existing?.status === 'declined') {
      existing.status = 'invited';
    }
    if (!existing) {
      const joinedCount = game.players.filter((p) => p.status === 'joined').length;
      if (joinedCount >= max) {
        throw new AppError('Game is full', 400, 'GAME_FULL');
      }
      game.players.push({
        user: new Types.ObjectId(userId),
        status: 'invited',
        score: 0,
        order: game.players.length,
      });
    }

    const { ctx } = engineCtx(game);
    if (!engine.canJoin(ctx, userId)) {
      throw new AppError('Cannot join this game', 400, 'CANNOT_JOIN');
    }
    const result = engine.onJoin(ctx, userId);
    applyPlayers(game, result.players);
    game.state = result.state;
    game.version = (game.version || 1) + 1;

    // Auto-start exact-capacity games (e.g. 2-player TTT / Connect Four)
    const after = engineCtx(game).ctx;
    if (engine.canStart(after) && engine.minPlayers === engine.maxPlayers) {
      const started = engine.start(after);
      applyPlayers(game, started.players);
      game.state = started.state;
      game.currentTurnUser = started.currentTurnUserId
        ? new Types.ObjectId(started.currentTurnUserId)
        : undefined;
      game.status = 'active';
      game.startedAt = new Date();
      game.expiresAt = new Date(Date.now() + engine.activeTtlMs);
      await game.save();
      const dto = formatGame(await loadGame(gameId), userId);
      emitGame(uid(game.conversation), 'game:started', { game: dto });
      emitGame(uid(game.conversation), 'game:updated', { game: dto });
      return dto;
    }

    await game.save();
    const dto = formatGame(await loadGame(gameId), userId);
    emitGame(uid(game.conversation), 'game:updated', { game: dto });
    return dto;
  },

  async decline(userId: string, gameId: string) {
    let game = await loadGame(gameId);
    await ensureConversationParticipant(uid(game.conversation), userId);
    game = await maybeExpire(game);
    if (game.status !== 'invited') throw new AppError('Game not open', 400, 'GAME_NOT_OPEN');
    const p = game.players.find((x) => uid(x.user) === userId);
    if (p) p.status = 'declined';
    // If creator cancels via decline
    if (uid(game.creator) === userId) {
      game.status = 'cancelled';
      game.completedAt = new Date();
    } else {
      const stillOpen = game.players.some(
        (x) => x.status === 'invited' || (x.status === 'joined' && uid(x.user) !== uid(game.creator))
      );
      // All non-creators declined and no room for open join → mark declined
      if (!stillOpen && game.players.every((x) => x.status === 'declined' || uid(x.user) === uid(game.creator))) {
        // keep invited for open group games
      }
    }
    game.version = (game.version || 1) + 1;
    await game.save();
    const dto = formatGame(await loadGame(gameId), userId);
    emitGame(uid(game.conversation), 'game:updated', { game: dto });
    return dto;
  },

  async cancel(userId: string, gameId: string) {
    let game = await loadGame(gameId);
    await ensureConversationParticipant(uid(game.conversation), userId);
    if (uid(game.creator) !== userId) throw new AppError('Only creator can cancel', 403, 'FORBIDDEN');
    if (game.status === 'completed') throw new AppError('Already completed', 400, 'GAME_DONE');
    game.status = 'cancelled';
    game.completedAt = new Date();
    game.version = (game.version || 1) + 1;
    await game.save();
    const dto = formatGame(await loadGame(gameId), userId);
    emitGame(uid(game.conversation), 'game:updated', { game: dto });
    return dto;
  },

  async start(userId: string, gameId: string) {
    let game = await loadGame(gameId);
    await ensureConversationParticipant(uid(game.conversation), userId);
    game = await maybeExpire(game);
    if (game.status !== 'invited') throw new AppError('Game not invitable', 400, 'GAME_NOT_OPEN');
    if (uid(game.creator) !== userId) {
      throw new AppError('Only creator can start', 403, 'FORBIDDEN');
    }
    const { engine, ctx } = engineCtx(game);
    if (!engine.canStart(ctx)) {
      throw new AppError('Not enough players', 400, 'NOT_ENOUGH_PLAYERS');
    }
    const started = engine.start(ctx);
    applyPlayers(game, started.players);
    game.state = started.state;
    game.currentTurnUser = started.currentTurnUserId
      ? new Types.ObjectId(started.currentTurnUserId)
      : undefined;
    game.status = 'active';
    game.startedAt = new Date();
    game.expiresAt = new Date(Date.now() + engine.activeTtlMs);
    game.version = (game.version || 1) + 1;
    await game.save();
    const dto = formatGame(await loadGame(gameId), userId);
    emitGame(uid(game.conversation), 'game:started', { game: dto });
    emitGame(uid(game.conversation), 'game:updated', { game: dto });
    return dto;
  },

  async action(
    userId: string,
    gameId: string,
    action: Record<string, unknown>,
    clientActionId?: string,
    expectedVersion?: number
  ) {
    if (!rateOk(actionHits, userId, ACTION_WINDOW_MS, ACTION_MAX)) {
      throw new AppError('Too many game actions', 429, 'RATE_LIMIT');
    }
    let game = await loadGame(gameId);
    await ensureConversationParticipant(uid(game.conversation), userId);
    game = await maybeExpire(game);

    if (game.status !== 'active') {
      throw new AppError('Game is not active', 400, 'GAME_NOT_ACTIVE');
    }

    const actionKey = clientActionId ? String(clientActionId).slice(0, 64) : '';
    // Idempotent replay: already applied — return current state without re-running
    if (actionKey && game.processedActionIds?.includes(actionKey)) {
      return formatGame(game, userId);
    }

    if (
      expectedVersion == null ||
      !Number.isInteger(Number(expectedVersion)) ||
      Number(expectedVersion) < 1
    ) {
      throw new AppError('expectedVersion is required', 400, 'VERSION_REQUIRED');
    }
    const expVer = Number(expectedVersion);
    if (expVer !== Number(game.version)) {
      throw new AppError('Game state conflict — refresh', 409, 'VERSION_CONFLICT');
    }

    const isPlayer = game.players.some((p) => uid(p.user) === userId && p.status === 'joined');
    if (!isPlayer) throw new AppError('Not a player in this game', 403, 'NOT_PLAYER');

    const { engine, ctx } = engineCtx(game);
    let result;
    try {
      result = engine.applyAction(ctx, userId, action || {});
    } catch (e) {
      if (e instanceof GameRuleError) {
        throw new AppError(e.message, e.status, e.code);
      }
      throw e;
    }

    const playersPayload = result.players.map((s) => ({
      user: new Types.ObjectId(s.userId),
      status: s.status,
      score: s.score,
      order: s.order,
      symbol: s.symbol,
    }));

    const setDoc: Record<string, unknown> = {
      state: result.state,
      players: playersPayload,
      currentTurnUser: result.currentTurnUserId
        ? new Types.ObjectId(result.currentTurnUserId)
        : null,
    };
    if (result.completed) {
      setDoc.status = 'completed';
      setDoc.completedAt = new Date();
      setDoc.isDraw = result.isDraw;
      setDoc.winnerIds = result.winnerIds.map((id) => new Types.ObjectId(id));
      setDoc.currentTurnUser = null;
    }

    // Atomic conditional update: version must still match + still active
    const filter: Record<string, unknown> = {
      _id: game._id,
      version: expVer,
      status: 'active',
    };
    if (actionKey) {
      filter.processedActionIds = { $ne: actionKey };
    }

    const update: Record<string, unknown> = {
      $set: setDoc,
      $inc: { version: 1 },
    };
    if (actionKey) {
      update.$push = {
        processedActionIds: { $each: [actionKey], $slice: -100 },
      };
    }

    const updated = await Game.findOneAndUpdate(filter, update, { new: true })
      .populate('creator', 'username displayName avatar')
      .populate('players.user', 'username displayName avatar');

    if (!updated) {
      // Race: re-check idempotency vs version conflict
      const again = await loadGame(gameId);
      if (actionKey && again.processedActionIds?.includes(actionKey)) {
        return formatGame(again, userId);
      }
      throw new AppError('Game state conflict — refresh', 409, 'VERSION_CONFLICT');
    }

    // Stats: claim → write → keep flag; on write failure roll back so retries work
    if (result.completed && updated.status === 'completed') {
      await tryRecordStats(updated);
    }

    const dto = formatGame(updated, userId);
    if (result.completed) {
      emitGame(uid(updated.conversation), 'game:completed', { game: dto });
    }
    emitGame(uid(updated.conversation), 'game:updated', { game: dto });
    return dto;
  },

  async rematch(userId: string, gameId: string) {
    const prev = await loadGame(gameId);
    await ensureConversationParticipant(uid(prev.conversation), userId);
    if (prev.status !== 'completed') {
      throw new AppError('Can only rematch completed games', 400, 'NOT_COMPLETED');
    }
    const isPlayer = prev.players.some((p) => uid(p.user) === userId && p.status === 'joined');
    if (!isPlayer && uid(prev.creator) !== userId) {
      throw new AppError('Only players can rematch', 403, 'FORBIDDEN');
    }

    const engine = getEngine(prev.gameType);
    const options = engine.validateOptions((prev.options || {}) as CreateGameOptions);
    const priorPlayers = prev.players
      .filter((p) => p.status === 'joined')
      .sort((a, b) => a.order - b.order);

    const players: IGame['players'] = priorPlayers.map((p, i) => ({
      user: p.user,
      status: uid(p.user) === userId ? 'joined' : 'invited',
      score: 0,
      order: i,
    }));
    // Ensure requester joined
    if (!players.some((p) => uid(p.user) === userId)) {
      players.unshift({
        user: new Types.ObjectId(userId),
        status: 'joined',
        score: 0,
        order: 0,
      });
    } else {
      for (const p of players) {
        if (uid(p.user) === userId) p.status = 'joined';
      }
    }

    const snaps: GamePlayerSnap[] = players.map((p) => ({
      userId: uid(p.user),
      status: p.status,
      score: 0,
      order: p.order,
    }));
    const state = engine.createInitialState(options, snaps);
    const game = await Game.create({
      conversation: prev.conversation,
      gameType: prev.gameType,
      status: 'invited',
      creator: userId,
      players,
      state,
      options,
      version: 1,
      rematchOf: prev._id,
      expiresAt: new Date(Date.now() + engine.inviteTtlMs),
      winnerIds: [],
      isDraw: false,
      processedActionIds: [],
    });

    await postSystemMessage(
      uid(prev.conversation),
      userId,
      `🎮 Rematch: ${engine.displayName}`,
      game._id.toString()
    );

    const dto = formatGame(await loadGame(game._id.toString()), userId);
    emitGame(uid(prev.conversation), 'game:created', { game: dto });
    emitGame(uid(prev.conversation), 'game:updated', { game: dto });
    return dto;
  },

  async expireStale(limit = 50) {
    const now = new Date();
    let n = 0;
    // Server-driven timers for timed games still within overall game TTL
    const timed = await Game.find({
      status: 'active',
      gameType: { $in: ['trivia_duel', 'emoji_guess'] },
    })
      .limit(limit)
      .populate('creator', 'username displayName avatar')
      .populate('players.user', 'username displayName avatar');
    for (const g of timed) {
      const ticked = await tickTimedGame(g);
      if (ticked) n += 1;
      if (ticked?.status === 'completed' && !ticked.statsRecorded) {
        await tryRecordStats(ticked);
      }
    }

    const stale = await Game.find({
      status: { $in: ['invited', 'active'] },
      expiresAt: { $lt: now },
    }).limit(limit);
    for (const g of stale) {
      g.status = 'expired';
      g.completedAt = now;
      await g.save();
      n += 1;
      const dto = formatGame(g);
      emitGame(uid(g.conversation), 'game:expired', { game: dto });
      emitGame(uid(g.conversation), 'game:updated', { game: dto });
    }

    // Retry stats for completed games (including abandoned leases)
    const pendingStats = await Game.find({
      status: 'completed',
      statsRecorded: { $ne: true },
    })
      .limit(20)
      .populate('players.user', 'username displayName avatar');
    for (const g of pendingStats) {
      await tryRecordStats(g);
    }

    return n;
  },

  /** Test / maintenance: attempt stats for a completed game (lease + ledger) */
  async ensureStats(gameId: string) {
    const game = await loadGame(gameId);
    await tryRecordStats(game);
    return formatGame(await loadGame(gameId));
  },
};
