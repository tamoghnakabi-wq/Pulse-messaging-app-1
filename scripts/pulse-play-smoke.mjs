/**
 * Pulse Play smoke: create invite → join → play → complete → stats/leaderboard.
 * Requires API + alice/bob.
 *
 * Usage: API_URL=http://127.0.0.1:5050 node scripts/pulse-play-smoke.mjs
 */
import { io } from 'socket.io-client';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const API = process.env.API_URL || 'http://127.0.0.1:5050';
const SMOKE_PASSWORD = process.env.SMOKE_PASSWORD || 'PulseCi_Test9x';
const LEGACY = 'Password1';
let failed = 0;

function ok(n, d = '') {
  console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`);
}
function fail(n, e) {
  failed++;
  console.error(`  ✗ ${n} — ${e instanceof Error ? e.message : e}`);
}

/** Prefer node:http — Node 26 undici fetch can throw "bad port" in some envs */
function requestJson(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { ...(opts.headers || {}) };
    const body = opts.body;
    if (body && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = {};
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            json = {};
          }
          resolve({ status: res.statusCode || 0, json, ok: (res.statusCode || 0) < 400 });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function api(p, opts = {}) {
  const { headers: extra, body, method } = opts;
  const res = await requestJson(`${API}/api${p}`, {
    method: method || (body ? 'POST' : 'GET'),
    body,
    headers: extra || {},
  });
  if (!res.ok || res.json.success === false) {
    const e = new Error(
      `${res.status} ${res.json?.error?.message || res.json?.error?.code || JSON.stringify(res.json)}`
    );
    e.status = res.status;
    e.code = res.json?.error?.code;
    e.body = res.json;
    throw e;
  }
  return res.json.data;
}

async function login(user) {
  for (const password of [SMOKE_PASSWORD, LEGACY]) {
    try {
      return await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ emailOrUsername: user, password }),
      });
    } catch {
      /* */
    }
  }
  throw new Error(`login ${user}`);
}

async function ensureSeed() {
  // Lightweight seed using same http transport
  for (const [username, email, displayName] of [
    ['alice', 'alice@pulse.test', 'Alice'],
    ['bob', 'bob@pulse.test', 'Bob'],
  ]) {
    try {
      await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ emailOrUsername: username, password: SMOKE_PASSWORD }),
      });
    } catch {
      try {
        await api('/auth/register', {
          method: 'POST',
          body: JSON.stringify({
            username,
            email,
            displayName,
            password: SMOKE_PASSWORD,
          }),
        });
      } catch {
        /* may already exist with other password */
      }
    }
  }
}

function once(socket, event, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${event}`)), ms);
    socket.once(event, (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}

async function main() {
  console.log('\nPulse Play smoke\n');
  await ensureSeed().catch(() => null);
  let alice, bob;
  try {
    alice = await login('alice');
    bob = await login('bob');
    ok('login');
  } catch (e) {
    fail('login', e);
    process.exit(1);
  }
  const authA = { Authorization: `Bearer ${alice.accessToken}` };
  const authB = { Authorization: `Bearer ${bob.accessToken}` };
  const aliceId = String(alice.user.id || alice.user._id);
  const bobId = String(bob.user.id || bob.user._id);

  let conv;
  try {
    const data = await api('/conversations/direct', {
      method: 'POST',
      headers: authA,
      body: JSON.stringify({ userId: bobId }),
    });
    conv = data.conversation || data;
    conv.id = String(conv.id || conv._id);
    ok('direct conversation', conv.id);
  } catch (e) {
    fail('conversation', e);
    process.exit(1);
  }

  const sb = io(API, {
    auth: { token: bob.accessToken },
    transports: ['websocket'],
  });
  await new Promise((res, rej) => {
    sb.on('connect', res);
    sb.on('connect_error', rej);
    setTimeout(() => rej(new Error('socket timeout')), 8000);
  });
  ok('bob socket');

  let game;
  try {
    const got = once(sb, 'game:created', 10000);
    const data = await api(`/games/conversation/${conv.id}`, {
      method: 'POST',
      headers: authA,
      body: JSON.stringify({ gameType: 'tic_tac_toe', options: {} }),
    });
    game = data.game;
    await got;
    ok('create + realtime game:created', game.id);
  } catch (e) {
    fail('create game', e);
    process.exit(1);
  }

  try {
    let rejected = false;
    try {
      await api(`/games/${game.id}/action`, {
        method: 'POST',
        headers: authB,
        body: JSON.stringify({ action: { cell: 0 }, expectedVersion: game.version }),
      });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error('expected reject before join');
    ok('reject action before join');
  } catch (e) {
    fail('authz before join', e);
  }

  // Missing expectedVersion rejected
  try {
    let bad = false;
    try {
      await api(`/games/${game.id}/action`, {
        method: 'POST',
        headers: authA,
        body: JSON.stringify({ action: { cell: 0 } }),
      });
    } catch (e) {
      bad = e.status === 400;
    }
    if (!bad) throw new Error('missing expectedVersion should 400');
    ok('missing expectedVersion rejected');
  } catch (e) {
    fail('version required', e);
  }

  try {
    const upd = once(sb, 'game:started', 10000);
    const data = await api(`/games/${game.id}/join`, { method: 'POST', headers: authB });
    game = data.game;
    if (game.status !== 'active') {
      throw new Error(`expected active after join, got ${game.status}`);
    }
    await upd.catch(() => null);
    ok('bob join auto-starts TTT', game.status);
  } catch (e) {
    fail('join', e);
    process.exit(1);
  }

  try {
    let bad = false;
    try {
      await api(`/games/${game.id}/action`, {
        method: 'POST',
        headers: authB,
        body: JSON.stringify({ action: { cell: 0 }, expectedVersion: game.version }),
      });
    } catch {
      bad = true;
    }
    if (!bad) throw new Error('bob should not move first');
    ok('out-of-turn rejected');
  } catch (e) {
    fail('out-of-turn', e);
  }

  // Stale version
  try {
    let bad = false;
    try {
      await api(`/games/${game.id}/action`, {
        method: 'POST',
        headers: authA,
        body: JSON.stringify({ action: { cell: 0 }, expectedVersion: 1 }),
      });
    } catch (e) {
      bad = e.status === 409 || e.code === 'VERSION_CONFLICT';
    }
    if (!bad) throw new Error('stale version should 409');
    ok('stale expectedVersion rejected');
  } catch (e) {
    fail('stale version', e);
  }

  try {
    const completed = once(sb, 'game:completed', 15000);
    const moves = [
      [authA, 0],
      [authB, 3],
      [authA, 1],
      [authB, 4],
      [authA, 2],
    ];
    for (const [auth, cell] of moves) {
      const data = await api(`/games/${game.id}/action`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          action: { cell },
          clientActionId: `m-${cell}-${Date.now()}`,
          expectedVersion: game.version,
        }),
      });
      game = data.game;
    }
    if (game.status !== 'completed') throw new Error(`status ${game.status}`);
    await completed.catch(() => null);
    ok('play to completion', `winners=${(game.winnerIds || []).join(',')}`);
  } catch (e) {
    fail('play', e);
  }

  // Stats + leaderboard after completed game
  try {
    const board = await api(`/games/conversation/${conv.id}/leaderboard`, {
      headers: authA,
    });
    const rows = board.leaderboard || [];
    if (rows.length < 2) {
      throw new Error(`leaderboard expected ≥2 rows, got ${rows.length}`);
    }
    const byId = new Map(rows.map((r) => [r.user?.id, r]));
    if (!byId.has(aliceId) || !byId.has(bobId)) {
      throw new Error('leaderboard missing alice or bob');
    }
    ok('leaderboard has both players', `n=${rows.length}`);

    const aliceStats = await api(`/games/stats/me?conversationId=${conv.id}`, {
      headers: authA,
    });
    const bobStats = await api(`/games/stats/me?conversationId=${conv.id}`, {
      headers: authB,
    });
    const as = aliceStats.stats || aliceStats;
    const bs = bobStats.stats || bobStats;
    if ((as.wins || 0) < 1) throw new Error(`alice conv wins=${as.wins}`);
    if ((bs.losses || 0) < 1 && (bs.wins || 0) + (bs.draws || 0) + (bs.losses || 0) < 1) {
      throw new Error(`bob conv stats empty ${JSON.stringify(bs)}`);
    }
    // Alice should have won this TTT
    if ((as.wins || 0) < 1) throw new Error('alice should have ≥1 conv win');
    if ((bs.losses || 0) < 1) throw new Error(`bob should have ≥1 conv loss, got ${JSON.stringify(bs)}`);

    const aliceGlobal = await api('/games/stats/me', { headers: authA });
    const bobGlobal = await api('/games/stats/me', { headers: authB });
    const ag = aliceGlobal.stats || aliceGlobal;
    const bg = bobGlobal.stats || bobGlobal;
    if ((ag.wins || 0) < 1) throw new Error('alice global wins');
    if ((bg.losses || 0) < 1) throw new Error('bob global losses');
    ok('stats winner/loser global + conversation');
  } catch (e) {
    fail('stats/leaderboard', e);
  }

  try {
    const id = 'idem-test-1';
    const g2 = (
      await api(`/games/conversation/${conv.id}`, {
        method: 'POST',
        headers: authA,
        body: JSON.stringify({ gameType: 'tic_tac_toe' }),
      })
    ).game;
    await api(`/games/${g2.id}/join`, { method: 'POST', headers: authB });
    const g2b = (await api(`/games/${g2.id}`, { headers: authA })).game;
    const r1 = await api(`/games/${g2b.id}/action`, {
      method: 'POST',
      headers: authA,
      body: JSON.stringify({
        action: { cell: 0 },
        clientActionId: id,
        expectedVersion: g2b.version,
      }),
    });
    // Replay same clientActionId with stale version — still idempotent success
    const r2 = await api(`/games/${g2b.id}/action`, {
      method: 'POST',
      headers: authA,
      body: JSON.stringify({
        action: { cell: 0 },
        clientActionId: id,
        expectedVersion: 1,
      }),
    });
    if (r2.game.version !== r1.game.version) {
      throw new Error('idempotent replay changed version');
    }
    const board = (r2.game.state?.board || []).filter(Boolean).length;
    if (board !== 1) throw new Error(`expected 1 mark after idempotent replay, got ${board}`);
    ok('idempotent action id (no double apply)', `v=${r2.game.version}`);
  } catch (e) {
    fail('idempotency', e);
  }

  // Rematch must not change prior stats counts unexpectedly
  try {
    const before = await api(`/games/stats/me?conversationId=${conv.id}`, {
      headers: authA,
    });
    const bw = (before.stats || before).wins || 0;
    await api(`/games/${game.id}/rematch`, { method: 'POST', headers: authA });
    const after = await api(`/games/stats/me?conversationId=${conv.id}`, {
      headers: authA,
    });
    const aw = (after.stats || after).wins || 0;
    if (aw !== bw) throw new Error(`rematch changed wins ${bw}→${aw}`);
    ok('rematch does not alter prior stats');
  } catch (e) {
    fail('rematch', e);
  }

  // Trivia privacy + early resolve
  try {
    const tg = (
      await api(`/games/conversation/${conv.id}`, {
        method: 'POST',
        headers: authA,
        body: JSON.stringify({
          gameType: 'trivia_duel',
          options: { rounds: 3, turnSeconds: 30 },
        }),
      })
    ).game;
    await api(`/games/${tg.id}/join`, { method: 'POST', headers: authB });
    await api(`/games/${tg.id}/start`, { method: 'POST', headers: authA });
    const active = (await api(`/games/${tg.id}`, { headers: authA })).game;
    if (active.state?.questions) throw new Error('trivia leaked questions array');
    if (active.state?.seed) throw new Error('trivia leaked seed');
    if (active.state?.round?.correctIndex != null) {
      throw new Error('trivia leaked correctIndex while active');
    }
    let early = false;
    try {
      await api(`/games/${tg.id}/action`, {
        method: 'POST',
        headers: authA,
        body: JSON.stringify({
          action: { type: 'resolve' },
          expectedVersion: active.version,
        }),
      });
    } catch (e) {
      early = e.status === 400;
    }
    if (!early) throw new Error('early resolve should fail');
    ok('trivia privacy + early resolve rejected');
  } catch (e) {
    fail('trivia privacy', e);
  }

  sb.close();
  console.log(failed === 0 ? '\nPASS Pulse Play smoke\n' : `\nFAIL ${failed}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
