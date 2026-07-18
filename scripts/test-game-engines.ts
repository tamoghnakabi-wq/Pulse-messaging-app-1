/**
 * Unit tests for Pulse Play game engines (production TypeScript modules).
 * Run: npx tsx scripts/test-game-engines.ts
 */
import { ticTacToeEngine } from '../backend/src/games/engines/ticTacToe';
import { connectFourEngine } from '../backend/src/games/engines/connectFour';
import { triviaDuelEngine } from '../backend/src/games/engines/triviaDuel';
import { emojiGuessEngine } from '../backend/src/games/engines/emojiGuess';
import type { EngineContext, GamePlayerSnap } from '../backend/src/games/types';
import { GameRuleError } from '../backend/src/games/types';

let failed = 0;
function ok(name: string) {
  console.log(`  ✓ ${name}`);
}
function fail(name: string, e: unknown) {
  failed++;
  console.error(`  ✗ ${name}`, e instanceof Error ? e.message : e);
}

function players2(): GamePlayerSnap[] {
  return [
    { userId: 'a', status: 'joined', score: 0, order: 0, symbol: 'X' },
    { userId: 'b', status: 'joined', score: 0, order: 1, symbol: 'O' },
  ];
}

function ctx(
  engine: typeof ticTacToeEngine,
  partial: Partial<EngineContext>
): EngineContext {
  return {
    gameType: engine.type,
    players: players2(),
    state: {},
    status: 'active',
    currentTurnUserId: 'a',
    creatorId: 'a',
    options: {},
    now: new Date(),
    version: 1,
    ...partial,
  };
}

console.log('\nPulse Play engine unit tests\n');

// ── Tic-Tac-Toe ──────────────────────────────────────────
try {
  const start = ticTacToeEngine.start(
    ctx(ticTacToeEngine, {
      status: 'invited',
      state: ticTacToeEngine.createInitialState({}, players2()),
    })
  );
  let c = ctx(ticTacToeEngine, {
    state: start.state,
    players: start.players,
    currentTurnUserId: start.currentTurnUserId,
  });
  // Out of turn
  try {
    ticTacToeEngine.applyAction(c, 'b', { cell: 0 });
    throw new Error('should fail out of turn');
  } catch (e) {
    if (!(e instanceof GameRuleError)) throw e;
  }
  ok('ttt rejects out-of-turn');

  let r = ticTacToeEngine.applyAction(c, 'a', { cell: 0 });
  c = { ...c, state: r.state, players: r.players, currentTurnUserId: r.currentTurnUserId || null };
  r = ticTacToeEngine.applyAction(c, 'b', { cell: 3 });
  c = { ...c, state: r.state, players: r.players, currentTurnUserId: r.currentTurnUserId || null };
  r = ticTacToeEngine.applyAction(c, 'a', { cell: 1 });
  c = { ...c, state: r.state, players: r.players, currentTurnUserId: r.currentTurnUserId || null };
  r = ticTacToeEngine.applyAction(c, 'b', { cell: 4 });
  c = { ...c, state: r.state, players: r.players, currentTurnUserId: r.currentTurnUserId || null };
  r = ticTacToeEngine.applyAction(c, 'a', { cell: 2 });
  if (!r.completed || r.winnerIds[0] !== 'a') throw new Error('expected a win');
  ok('ttt X wins top row');

  // Duplicate cell
  const s2 = ticTacToeEngine.start(
    ctx(ticTacToeEngine, { status: 'invited', state: ticTacToeEngine.createInitialState({}, players2()) })
  );
  let c2 = ctx(ticTacToeEngine, {
    state: s2.state,
    players: s2.players,
    currentTurnUserId: s2.currentTurnUserId,
  });
  c2 = {
    ...c2,
    state: ticTacToeEngine.applyAction(c2, 'a', { cell: 4 }).state,
    currentTurnUserId: 'b',
  };
  try {
    ticTacToeEngine.applyAction(c2, 'b', { cell: 4 });
    throw new Error('occupied should fail');
  } catch (e) {
    if (!(e instanceof GameRuleError)) throw e;
  }
  ok('ttt rejects occupied cell');
} catch (e) {
  fail('tic-tac-toe', e);
}

// ── Connect Four ─────────────────────────────────────────
try {
  const start = connectFourEngine.start(
    ctx(connectFourEngine, {
      status: 'invited',
      state: connectFourEngine.createInitialState({}, players2()),
      players: [
        { userId: 'a', status: 'joined', score: 0, order: 0 },
        { userId: 'b', status: 'joined', score: 0, order: 1 },
      ],
    })
  );
  let c = ctx(connectFourEngine, {
    state: start.state,
    players: start.players,
    currentTurnUserId: start.currentTurnUserId,
  });
  // Vertical win for R in col 0
  for (let i = 0; i < 3; i++) {
    let r = connectFourEngine.applyAction(c, 'a', { column: 0 });
    c = { ...c, state: r.state, players: r.players, currentTurnUserId: r.currentTurnUserId || null };
    r = connectFourEngine.applyAction(c, 'b', { column: 1 });
    c = { ...c, state: r.state, players: r.players, currentTurnUserId: r.currentTurnUserId || null };
  }
  const win = connectFourEngine.applyAction(c, 'a', { column: 0 });
  if (!win.completed || win.winnerIds[0] !== 'a') throw new Error('expected vertical win');
  ok('connect four vertical win');

  try {
    connectFourEngine.applyAction(
      { ...c, currentTurnUserId: 'b' },
      'b',
      { column: 99 }
    );
    throw new Error('bad col');
  } catch (e) {
    if (!(e instanceof GameRuleError)) throw e;
  }
  ok('connect four rejects invalid column');
} catch (e) {
  fail('connect-four', e);
}

// ── Trivia ───────────────────────────────────────────────
try {
  const opts = triviaDuelEngine.validateOptions({ rounds: 3, turnSeconds: 20 });
  const state = triviaDuelEngine.createInitialState(opts, players2());
  const started = triviaDuelEngine.start(
    ctx(triviaDuelEngine, {
      status: 'invited',
      state,
      options: opts,
      players: players2(),
    })
  );
  let c = ctx(triviaDuelEngine, {
    status: 'active',
    state: started.state,
    players: players2(),
    options: opts,
    currentTurnUserId: null,
  });
  const r1 = triviaDuelEngine.applyAction(c, 'a', { type: 'answer', choice: 0 });
  c = { ...c, state: r1.state, players: r1.players };
  // Duplicate answer
  try {
    triviaDuelEngine.applyAction(c, 'a', { type: 'answer', choice: 1 });
    throw new Error('dup');
  } catch (e) {
    if (!(e instanceof GameRuleError)) throw e;
  }
  ok('trivia rejects duplicate answer');

  // Early resolve rejected (server clock)
  try {
    triviaDuelEngine.applyAction(c, 'a', { type: 'resolve' });
    throw new Error('early resolve should fail');
  } catch (e) {
    if (!(e instanceof GameRuleError) || e.code !== 'ROUND_NOT_ENDED') throw e;
  }
  ok('trivia rejects early resolve');

  // Sanitization: no future questions / seed / correctIndex while active
  const safe = triviaDuelEngine.sanitizeStateForClient(c.state, 'a', c);
  if ((safe as { questions?: unknown }).questions) throw new Error('leaked questions');
  if ((safe as { seed?: unknown }).seed) throw new Error('leaked seed');
  const round = safe.round as { correctIndex?: number; revealed?: boolean; prompt?: string };
  if (!round?.prompt) throw new Error('missing current prompt');
  if (round.correctIndex !== undefined) throw new Error('leaked correctIndex');
  ok('trivia DTO hides future questions and answers');

  // After deadline: enter reveal (answer visible), then advance after revealEndsAt
  const endsAt = (c.state.round as { endsAt: number }).endsAt;
  const afterDeadline = ctx(triviaDuelEngine, {
    ...c,
    now: new Date(endsAt + 1),
    state: c.state,
    players: c.players,
  });
  const res1 = triviaDuelEngine.applyAction(afterDeadline, 'a', { type: 'resolve' });
  const rev = res1.state.round as { revealed?: boolean; correctIndex?: number; revealEndsAt?: number };
  if (!rev?.revealed || rev.correctIndex === undefined) throw new Error('expected reveal state');
  const safeReveal = triviaDuelEngine.sanitizeStateForClient(res1.state, 'a', afterDeadline);
  if ((safeReveal.round as { correctIndex?: number })?.correctIndex === undefined) {
    throw new Error('client should see correctIndex during reveal');
  }
  const scoreAfter = res1.players.find((p) => p.userId === 'a')?.score || 0;
  // Mid-reveal: no double score
  const midReveal = ctx(triviaDuelEngine, {
    ...afterDeadline,
    state: res1.state,
    players: res1.players,
    now: new Date(endsAt + 100),
  });
  const mid = triviaDuelEngine.applyAction(midReveal, 'a', { type: 'resolve' });
  if ((mid.players.find((p) => p.userId === 'a')?.score || 0) !== scoreAfter) {
    throw new Error('double scored during reveal');
  }
  // After reveal window: advance
  const afterReveal = ctx(triviaDuelEngine, {
    ...midReveal,
    state: mid.state,
    players: mid.players,
    now: new Date((rev.revealEndsAt || endsAt) + 1),
  });
  const advanced = triviaDuelEngine.applyAction(afterReveal, 'a', { type: 'resolve' });
  if ((advanced.state.round as { index?: number })?.index === rev.correctIndex && advanced.state.phase === 'reveal') {
    /* may complete or new round */
  }
  if ((advanced.players.find((p) => p.userId === 'a')?.score || 0) !== scoreAfter) {
    throw new Error('score changed on advance');
  }
  ok('trivia reveal window then advance without double score');
} catch (e) {
  fail('trivia', e);
}

// ── Emoji Guess ──────────────────────────────────────────
try {
  const opts = emojiGuessEngine.validateOptions({ rounds: 3 });
  const state = emojiGuessEngine.createInitialState(opts, players2());
  const started = emojiGuessEngine.start(
    ctx(emojiGuessEngine, { status: 'invited', state, options: opts, players: players2() })
  );
  let c = ctx(emojiGuessEngine, {
    status: 'active',
    state: started.state,
    players: players2(),
    options: opts,
  });
  const riddle = (c.state.riddles as { answers: string[] }[])?.[0];
  if (!riddle) throw new Error('no riddle');
  const wrong = emojiGuessEngine.applyAction(c, 'a', { type: 'guess', guess: 'zzzz-not-it' });
  c = { ...c, state: wrong.state, players: wrong.players };
  try {
    emojiGuessEngine.applyAction(c, 'a', { type: 'guess', guess: 'again' });
    throw new Error('dup guess');
  } catch (e) {
    if (!(e instanceof GameRuleError)) throw e;
  }
  ok('emoji rejects second guess same round');

  // Early resolve
  try {
    emojiGuessEngine.applyAction(c, 'a', { type: 'resolve' });
    throw new Error('early resolve');
  } catch (e) {
    if (!(e instanceof GameRuleError) || e.code !== 'ROUND_NOT_ENDED') throw e;
  }
  ok('emoji rejects early resolve');

  const safeE = emojiGuessEngine.sanitizeStateForClient(c.state, 'a', c);
  if ((safeE as { riddles?: unknown }).riddles) throw new Error('leaked riddles');
  if ((safeE as { seed?: unknown }).seed) throw new Error('leaked seed');
  const er = safeE.round as { answerReveal?: string; emoji?: string };
  if (!er?.emoji) throw new Error('missing current emoji');
  if (er.answerReveal) throw new Error('leaked answer early');
  ok('emoji DTO hides future riddles and answers');

  // Fresh game correct guess
  const s2 = emojiGuessEngine.start(
    ctx(emojiGuessEngine, {
      status: 'invited',
      state: emojiGuessEngine.createInitialState(opts, players2()),
      options: opts,
      players: players2(),
    })
  );
  const c2 = ctx(emojiGuessEngine, {
    status: 'active',
    state: s2.state,
    players: players2(),
    options: opts,
  });
  const ans = (c2.state.riddles as { answers: string[] }[])[0].answers[0];
  const good = emojiGuessEngine.applyAction(c2, 'b', { type: 'guess', guess: ans });
  if ((good.players.find((p) => p.userId === 'b')?.score || 0) < 1) {
    throw new Error('score not awarded');
  }
  ok('emoji awards score on correct guess');
} catch (e) {
  fail('emoji-guess', e);
}

console.log(failed === 0 ? '\nAll game engine tests passed.\n' : `\n${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
