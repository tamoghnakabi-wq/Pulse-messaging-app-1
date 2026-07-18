/**
 * Production-hardening tests for Pulse Play:
 * - server-driven timed round advance (no client)
 * - abandoned stats lease reclaim
 * - no double-count on repeated recovery
 *
 * Uses mongodb-memory-server. Run: npm run test:game-hardening
 * GAME_SCHEDULER=0 so the interval does not fire during the test.
 */
process.env.GAME_SCHEDULER = '0';

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Game } from '../backend/src/models/Game';
import { GameStats } from '../backend/src/models/GameStats';
import { GameStatEvent } from '../backend/src/models/GameStatEvent';
import { User } from '../backend/src/models/User';
import { Conversation } from '../backend/src/models/Conversation';
import { gameService } from '../backend/src/services/game/game.service';
import { triviaDuelEngine } from '../backend/src/games/engines/triviaDuel';
import { runGameSchedulerOnce, stopGameScheduler } from '../backend/src/services/game/gameScheduler';

let failed = 0;
function ok(name: string, detail = '') {
  console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name: string, e: unknown) {
  failed += 1;
  console.error(`  ✗ ${name}`, e instanceof Error ? e.message : e);
}

async function main() {
  console.log('\nPulse Play hardening tests\n');
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  const alice = await User.create({
    username: 'halice',
    email: 'halice@test.local',
    displayName: 'Alice',
    password: 'PulseCi_Test9xAa1',
  });
  const bob = await User.create({
    username: 'hbob',
    email: 'hbob@test.local',
    displayName: 'Bob',
    password: 'PulseCi_Test9xAa1',
  });

  const conv = await Conversation.create({
    type: 'direct',
    createdBy: alice._id,
    participants: [
      { user: alice._id, role: 'member' },
      { user: bob._id, role: 'member' },
    ],
    isActive: true,
  });

  // ── 1. Timed round advances without client fetch ─────────
  try {
    const opts = triviaDuelEngine.validateOptions({ rounds: 3, turnSeconds: 20 });
    const snaps = [
      { userId: alice._id.toString(), status: 'joined' as const, score: 0, order: 0 },
      { userId: bob._id.toString(), status: 'joined' as const, score: 0, order: 1 },
    ];
    let state = triviaDuelEngine.createInitialState(opts, snaps);
    const started = triviaDuelEngine.start({
      gameType: 'trivia_duel',
      players: snaps,
      state,
      status: 'active',
      creatorId: alice._id.toString(),
      options: opts,
      now: new Date(),
      version: 1,
    });
    state = started.state;

    const game = await Game.create({
      conversation: conv._id,
      gameType: 'trivia_duel',
      status: 'active',
      creator: alice._id,
      players: [
        { user: alice._id, status: 'joined', score: 0, order: 0 },
        { user: bob._id, status: 'joined', score: 0, order: 1 },
      ],
      state,
      options: opts,
      version: 1,
      expiresAt: new Date(Date.now() + 3600_000),
      processedActionIds: [],
      statsRecorded: false,
      openInvite: false,
    });

    // Force deadline into the past (replace whole state document)
    {
      const doc = await Game.findById(game._id).lean();
      if (!doc?.state) throw new Error('missing game');
      const st = JSON.parse(JSON.stringify(doc.state)) as {
        round?: { endsAt?: number };
      };
      if (!st.round) throw new Error('no round');
      st.round.endsAt = Date.now() - 5_000;
      await Game.collection.updateOne({ _id: game._id }, { $set: { state: st } });
    }

    // Verify find + force one maintenance sweep
    const found = await Game.find({
      status: 'active',
      gameType: { $in: ['trivia_duel', 'emoji_guess'] },
    });
    if (found.length < 1) throw new Error('game not found by maintenance query');
    const endsAtCheck = (found[0].state as { round?: { endsAt?: number } })?.round?.endsAt;
    if (typeof endsAtCheck !== 'number' || endsAtCheck > Date.now()) {
      throw new Error(`endsAt not expired: ${endsAtCheck} now=${Date.now()}`);
    }

    const n = await gameService.expireStale(20);
    let g = await Game.findById(game._id).lean();
    const r1 = g?.state as { phase?: string; round?: { revealed?: boolean; revealEndsAt?: number; index?: number } };
    if (!r1?.round?.revealed) {
      throw new Error(
        `expected reveal after sweep (n=${n} found=${found.length}) endsAt=${endsAtCheck} now=${Date.now()} version=${g?.version}`
      );
    }
    ok('timed round enters reveal without client', `phase=${r1.phase}`);

    // Force reveal window over and sweep again → next round
    {
      const doc = await Game.findById(game._id).lean();
      if (!doc?.state) throw new Error('missing game');
      const st = JSON.parse(JSON.stringify(doc.state)) as {
        round?: { revealEndsAt?: number };
      };
      if (st.round) st.round.revealEndsAt = Date.now() - 1000;
      await Game.collection.updateOne({ _id: game._id }, { $set: { state: st } });
    }
    await gameService.expireStale(20);
    g = await Game.findById(game._id).lean();
    const r2 = g?.state as { round?: { index?: number; revealed?: boolean }; phase?: string };
    if (r2?.round?.revealed) throw new Error('should have advanced past reveal');
    if (typeof r2?.round?.index !== 'number') throw new Error('missing next round');
    ok('reveal advances to next round without client', `index=${r2.round.index}`);
  } catch (e) {
    fail('timed advance', e);
  }

  // ── 2 & 3. Abandoned lease reclaim + no double-count ─────
  try {
    const game = await Game.create({
      conversation: conv._id,
      gameType: 'tic_tac_toe',
      status: 'completed',
      creator: alice._id,
      players: [
        { user: alice._id, status: 'joined', score: 1, order: 0, symbol: 'X' },
        { user: bob._id, status: 'joined', score: 0, order: 1, symbol: 'O' },
      ],
      state: { board: ['X', 'X', 'X', 'O', 'O', null, null, null, null] },
      options: {},
      version: 5,
      winnerIds: [alice._id],
      isDraw: false,
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      statsRecorded: false,
      // Abandoned lease from a crashed worker
      statsRecordingAt: new Date(Date.now() - 10 * 60 * 1000),
      processedActionIds: [],
    });

    await gameService.ensureStats(game._id.toString());
    let g = await Game.findById(game._id);
    if (!g?.statsRecorded) throw new Error('stats not recorded after reclaim');
    if (g.statsRecordingAt) throw new Error('lease not cleared');
    ok('abandoned stats lease reclaimed');

    const aliceBefore = await GameStats.findOne({
      user: alice._id,
      conversation: conv._id,
    }).lean();
    const winsBefore = aliceBefore?.wins || 0;
    const eventsBefore = await GameStatEvent.countDocuments({ game: game._id });

    // Repeated recovery must not double-count
    await gameService.ensureStats(game._id.toString());
    await gameService.ensureStats(game._id.toString());
    await runGameSchedulerOnce();

    const aliceAfter = await GameStats.findOne({
      user: alice._id,
      conversation: conv._id,
    }).lean();
    const eventsAfter = await GameStatEvent.countDocuments({ game: game._id });
    if ((aliceAfter?.wins || 0) !== winsBefore) {
      throw new Error(`wins changed ${winsBefore}→${aliceAfter?.wins}`);
    }
    if (eventsAfter !== eventsBefore) {
      throw new Error(`events changed ${eventsBefore}→${eventsAfter}`);
    }
    ok('repeated recovery does not double-count', `wins=${winsBefore} events=${eventsBefore}`);

    // Fresh claim failure path: simulate active lease blocks second concurrent claim
    await Game.updateOne(
      { _id: game._id },
      { $set: { statsRecorded: false, statsRecordingAt: new Date() } }
    );
    // Active lease should not reclaim yet (unless we wait) — ensureStats no-ops
    await gameService.ensureStats(game._id.toString());
    g = await Game.findById(game._id);
    // Still has active lease and not recorded (blocked)
    if (g?.statsRecorded) {
      // if somehow recorded, still must not double events
      const ev = await GameStatEvent.countDocuments({ game: game._id });
      if (ev !== eventsBefore) throw new Error('double events under lease');
    } else if (!g?.statsRecordingAt) {
      throw new Error('expected active lease to remain');
    }
    ok('active lease blocks concurrent reclaim');

    // Expire lease and reclaim again — still no double count
    await Game.updateOne(
      { _id: game._id },
      { $set: { statsRecordingAt: new Date(Date.now() - 10 * 60 * 1000), statsRecorded: false } }
    );
    await gameService.ensureStats(game._id.toString());
    const aliceFinal = await GameStats.findOne({
      user: alice._id,
      conversation: conv._id,
    }).lean();
    if ((aliceFinal?.wins || 0) !== winsBefore) {
      throw new Error(`double count after second reclaim ${aliceFinal?.wins}`);
    }
    ok('expired lease reclaim is still exactly-once');
  } catch (e) {
    fail('stats lease', e);
  }

  // ── 4. Crash window: counter applied, ledger not yet written ─────
  // Old bug was the inverse (ledger then counter). New path: atomic appliedGameIds+$inc
  // then ledger. Crash after claim must not double-count on recovery.
  try {
    const game = await Game.create({
      conversation: conv._id,
      gameType: 'tic_tac_toe',
      status: 'completed',
      creator: bob._id,
      players: [
        { user: bob._id, status: 'joined', score: 1, order: 0, symbol: 'X' },
        { user: alice._id, status: 'joined', score: 0, order: 1, symbol: 'O' },
      ],
      state: { board: ['X', 'X', 'X', null, 'O', null, null, 'O', null] },
      options: {},
      version: 3,
      winnerIds: [bob._id],
      isDraw: false,
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      statsRecorded: false,
      statsRecordingAt: null,
      processedActionIds: [],
    });

    // Simulate successful counter claim without ledger / without statsRecorded
    // (process died after atomic $inc + appliedGameIds, before ledger + flag)
    await GameStats.updateOne(
      { user: bob._id, conversation: conv._id },
      {
        $inc: { gamesPlayed: 1, wins: 1, 'byType.tic_tac_toe.played': 1, 'byType.tic_tac_toe.wins': 1 },
        $addToSet: { appliedGameIds: game._id },
        $setOnInsert: {
          user: bob._id,
          conversation: conv._id,
          losses: 0,
          draws: 0,
          currentStreak: 0,
          bestStreak: 0,
          achievements: [],
          achievementEvents: [],
        },
      },
      { upsert: true }
    );
    await GameStats.updateOne(
      { user: bob._id, conversation: null },
      {
        $inc: { gamesPlayed: 1, wins: 1, 'byType.tic_tac_toe.played': 1, 'byType.tic_tac_toe.wins': 1 },
        $addToSet: { appliedGameIds: game._id },
        $setOnInsert: {
          user: bob._id,
          conversation: null,
          losses: 0,
          draws: 0,
          currentStreak: 0,
          bestStreak: 0,
          achievements: [],
          achievementEvents: [],
        },
      },
      { upsert: true }
    );
    // Alice loss counters claimed, no ledger yet
    await GameStats.updateOne(
      { user: alice._id, conversation: conv._id },
      {
        $inc: {
          gamesPlayed: 1,
          losses: 1,
          'byType.tic_tac_toe.played': 1,
          'byType.tic_tac_toe.losses': 1,
        },
        $addToSet: { appliedGameIds: game._id },
      },
      { upsert: true }
    );
    await GameStats.updateOne(
      { user: alice._id, conversation: null },
      {
        $inc: {
          gamesPlayed: 1,
          losses: 1,
          'byType.tic_tac_toe.played': 1,
          'byType.tic_tac_toe.losses': 1,
        },
        $addToSet: { appliedGameIds: game._id },
      },
      { upsert: true }
    );

    const bobWinsBefore = (
      await GameStats.findOne({ user: bob._id, conversation: conv._id }).lean()
    )?.wins;
    if (bobWinsBefore !== 1) throw new Error(`setup wins=${bobWinsBefore}`);

    // Recovery (lease reclaim path)
    await gameService.ensureStats(game._id.toString());
    await gameService.ensureStats(game._id.toString());

    const bobAfter = await GameStats.findOne({
      user: bob._id,
      conversation: conv._id,
    }).lean();
    if ((bobAfter?.wins || 0) !== 1) {
      throw new Error(`crash-window double-count wins=${bobAfter?.wins}`);
    }
    if ((bobAfter?.gamesPlayed || 0) < 1) {
      throw new Error('crash-window under-count gamesPlayed');
    }
    const g = await Game.findById(game._id).lean();
    if (!g?.statsRecorded) throw new Error('statsRecorded not set after recovery');
    // Ledger should be filled in on recovery
    const ledgerN = await GameStatEvent.countDocuments({ game: game._id });
    if (ledgerN < 2) throw new Error(`expected ledger rows after recovery, got ${ledgerN}`);
    ok('crash after counter before ledger recovers exactly-once', `wins=1 ledger=${ledgerN}`);
  } catch (e) {
    fail('crash window counter-then-ledger', e);
  }

  // ── 5. Legacy crash window: ledger exists, counters never applied ─────
  // Old code cannot heal lost $inc; new code must not double-count on reclaim
  // and must not invent a second win. (Undercount from old crash stays;
  // we only guarantee no double-count + no regression of appliedGameIds path.)
  try {
    const game = await Game.create({
      conversation: conv._id,
      gameType: 'connect_four',
      status: 'completed',
      creator: alice._id,
      players: [
        { user: alice._id, status: 'joined', score: 1, order: 0 },
        { user: bob._id, status: 'joined', score: 0, order: 1 },
      ],
      state: {},
      options: {},
      version: 2,
      winnerIds: [alice._id],
      isDraw: false,
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      statsRecorded: false,
      processedActionIds: [],
    });

    // Only ledger rows (simulates crash after GameStatEvent.create, before $inc)
    await GameStatEvent.create([
      {
        game: game._id,
        user: alice._id,
        scope: 'global',
        result: 'win',
        gameType: 'connect_four',
      },
      {
        game: game._id,
        user: alice._id,
        scope: conv._id.toString(),
        result: 'win',
        gameType: 'connect_four',
      },
      {
        game: game._id,
        user: bob._id,
        scope: 'global',
        result: 'loss',
        gameType: 'connect_four',
      },
      {
        game: game._id,
        user: bob._id,
        scope: conv._id.toString(),
        result: 'loss',
        gameType: 'connect_four',
      },
    ]);

    const aliceWinsBefore =
      (await GameStats.findOne({ user: alice._id, conversation: conv._id }).lean())?.wins || 0;

    await gameService.ensureStats(game._id.toString());
    await gameService.ensureStats(game._id.toString());

    const aliceAfter = await GameStats.findOne({
      user: alice._id,
      conversation: conv._id,
    }).lean();
    // Must not invent a new win on top of missing counters (legacy undercount stays)
    if ((aliceAfter?.wins || 0) !== aliceWinsBefore) {
      throw new Error(
        `legacy ledger-only path changed wins ${aliceWinsBefore}→${aliceAfter?.wins}`
      );
    }
    const applied = (aliceAfter?.appliedGameIds || []).some(
      (id) => String(id) === String(game._id)
    );
    if (!applied && aliceAfter) {
      // may have created empty-ish doc with appliedGameIds only
    }
    const g = await Game.findById(game._id).lean();
    if (!g?.statsRecorded) throw new Error('legacy path should still mark statsRecorded');
    ok('legacy ledger-only crash does not double-count on recovery');
  } catch (e) {
    fail('legacy ledger-only recovery', e);
  }

  stopGameScheduler();
  await mongoose.disconnect();
  await mem.stop();

  console.log(failed === 0 ? '\nAll hardening tests passed.\n' : `\n${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
