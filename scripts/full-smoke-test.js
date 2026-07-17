/**
 * Full Pulse API + Socket smoke test (no browser UI).
 * Usage: node scripts/full-smoke-test.js
 */
const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');

const API = process.env.API_URL || 'http://127.0.0.1:5050';/** Must pass password policy (not on common list). Override with SMOKE_PASSWORD. */
const SMOKE_PASSWORD = process.env.SMOKE_PASSWORD || 'PulseCi_Test9x';
const LEGACY_PASSWORD = 'Password1';
const results = [];
let failed = 0;

async function loginUser(emailOrUsername) {
  for (const password of [SMOKE_PASSWORD, LEGACY_PASSWORD]) {
    try {
      return await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ emailOrUsername, password }),
      });
    } catch {
      /* try next */
    }
  }
  throw new Error(`login failed for ${emailOrUsername} (tried smoke + legacy passwords)`);
}

/** API often wraps entities: { conversation }, { message }, { user } */
function unwrap(data, key) {
  if (!data || typeof data !== 'object') return data;
  if (key && data[key] != null) return data[key];
  return data;
}

function asConversation(data) {
  const c = unwrap(data, 'conversation');
  if (!c || typeof c !== 'object') return null;
  const id = c.id || c._id;
  if (!id) return null;
  return { ...c, id: String(id) };
}

function asMessage(data) {
  const m = unwrap(data, 'message');
  if (!m || typeof m !== 'object') return null;
  const id = m.id || m._id;
  if (!id) return null;
  return { ...m, id: String(id) };
}

function participantMatches(p, userId, username) {
  const u = p?.user || p;
  const id = String(u?.id || u?._id || u || '');
  const uname = u?.username;
  return id === String(userId) || uname === username;
}

function ok(name, detail = '') {
  results.push({ name, pass: true, detail });
  console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, err) {
  failed += 1;
  const detail = err instanceof Error ? err.message : String(err);
  results.push({ name, pass: false, detail });
  console.error(`  ✗ ${name} — ${detail}`);
}

async function api(p, opts = {}) {
  const { headers: extraHeaders, body, ...rest } = opts;
  // Don't force JSON content-type for FormData (browser sets multipart boundary)
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const headers = {
    ...(isForm ? {} : { 'Content-Type': 'application/json' }),
    ...(extraHeaders || {}),
  };
  const res = await fetch(`${API}/api${p}`, {
    ...rest,
    body,
    headers,
  });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status} non-JSON`);
  }
  if (!res.ok || json.success === false) {
    const msg = json?.error?.message || json?.error?.code || JSON.stringify(json);
    const e = new Error(`${res.status} ${msg}`);
    e.status = res.status;
    e.body = json;
    throw e;
  }
  return json.data;
}

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const s = io(API, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      auth: { token },
    });
    const t = setTimeout(() => reject(new Error('socket connect timeout')), 10000);
    s.on('connect', () => {
      clearTimeout(t);
      resolve(s);
    });
    s.on('connect_error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

function once(socket, event, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (p) => {
      clearTimeout(t);
      resolve(p);
    });
  });
}

async function main() {
  console.log(`\nPulse full smoke — API ${API}\n`);

  // ── Health ──────────────────────────────────────────────
  console.log('1. Health');
  try {
    const h = await api('/health');
    if (h.status !== 'ok') throw new Error(JSON.stringify(h));
    ok('GET /health');
  } catch (e) {
    fail('GET /health', e);
  }

  // ── Auth ────────────────────────────────────────────────
  console.log('\n2. Auth');
  let alice, bob;
  try {
    alice = await loginUser('alice');
    if (!alice.accessToken || !alice.user?.id) throw new Error('missing token/user');
    ok('login alice', alice.user.username);
  } catch (e) {
    fail('login alice', e);
    process.exit(1);
  }
  try {
    bob = await loginUser('bob');
    ok('login bob', bob.user.username);
  } catch (e) {
    fail('login bob', e);
    process.exit(1);
  }

  const authA = { Authorization: `Bearer ${alice.accessToken}` };
  const authB = { Authorization: `Bearer ${bob.accessToken}` };

  try {
    const me = await api('/auth/me', { headers: authA });
    if (me.id !== alice.user.id && me.user?.id !== alice.user.id) {
      // me() may return user directly
      const id = me.id || me.user?.id;
      if (id !== alice.user.id) throw new Error('me id mismatch');
    }
    ok('GET /auth/me');
  } catch (e) {
    fail('GET /auth/me', e);
  }

  try {
    await api('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: alice.refreshToken }),
    });
    ok('POST /auth/refresh');
  } catch (e) {
    fail('POST /auth/refresh', e);
  }

  // bad login
  try {
    await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ emailOrUsername: 'alice', password: 'WrongPassword99' }),
    });
    fail('bad password rejected', 'expected 401');
  } catch (e) {
    if (e.status === 401 || /invalid|credentials/i.test(e.message)) ok('bad password rejected');
    else fail('bad password rejected', e);
  }

  // ── Users ───────────────────────────────────────────────
  console.log('\n3. Users');
  try {
    const found = await api('/users/search?q=bob', { headers: authA });
    const list = Array.isArray(found) ? found : found.users || found.results || [];
    ok('search users', `hits=${list.length}`);
  } catch (e) {
    fail('search users', e);
  }

  try {
    const u = await api(`/users/${bob.user.id}`, { headers: authA });
    ok('get user profile', u.username || u.displayName || bob.user.id);
  } catch (e) {
    fail('get user profile', e);
  }

  try {
    await api('/users/me', {
      method: 'PUT',
      headers: authA,
      body: JSON.stringify({ displayName: 'Alice' }),
    });
    ok('update profile displayName');
  } catch (e) {
    // some APIs use PATCH /users/me
    try {
      await api('/users/me', {
        method: 'PATCH',
        headers: authA,
        body: JSON.stringify({ displayName: 'Alice' }),
      });
      ok('update profile displayName (PATCH)');
    } catch (e2) {
      fail('update profile', e2);
    }
  }

  // ── Conversations ───────────────────────────────────────
  console.log('\n4. Conversations');
  let convsA = [];
  let direct = null;
  try {
    const listData = await api('/conversations?filter=all', { headers: authA });
    convsA = Array.isArray(listData)
      ? listData
      : listData.conversations || listData.items || [];
    ok('list conversations', `n=${convsA.length}`);
    direct =
      asConversation(
        convsA.find(
          (c) =>
            c.type === 'direct' &&
            (c.participants || []).some((p) =>
              participantMatches(p, bob.user.id, bob.user.username)
            )
        )
      ) || null;
  } catch (e) {
    fail('list conversations', e);
  }

  // Ensure direct conversation exists (API returns { conversation })
  if (!direct?.id) {
    try {
      const created = await api('/conversations/direct', {
        method: 'POST',
        headers: authA,
        body: JSON.stringify({ userId: bob.user.id }),
      });
      direct = asConversation(created);
      if (!direct?.id) {
        throw new Error(
          `create direct returned no conversation.id — keys: ${Object.keys(created || {}).join(',')}`
        );
      }
      ok('create/get direct conversation', direct.id);
    } catch (e) {
      fail('create/get direct conversation', e);
    }
  } else {
    ok('existing direct with bob', direct.id);
  }

  // Hard require: message/call sections must not skip silently
  if (!direct?.id) {
    fail('direct conversation required', 'missing id after list/create — aborting chat tests');
  }

  let group = null;
  try {
    const g = await api('/conversations/group', {
      method: 'POST',
      headers: authA,
      body: JSON.stringify({
        name: `Smoke Group ${Date.now()}`,
        participantIds: [bob.user.id],
      }),
    });
    group = asConversation(g);
    if (!group?.id) throw new Error('group response missing conversation.id');
    ok('create group', group.id);
  } catch (e) {
    fail('create group', e);
  }

  if (direct?.id) {
    try {
      const full = asConversation(await api(`/conversations/${direct.id}`, { headers: authA }));
      ok('get conversation detail', full?.id || direct.id);
    } catch (e) {
      fail('get conversation detail', e);
    }

    try {
      await api(`/conversations/${direct.id}/prefs`, {
        method: 'PATCH',
        headers: authA,
        body: JSON.stringify({ isPinned: true }),
      });
      await api(`/conversations/${direct.id}/prefs`, {
        method: 'PATCH',
        headers: authA,
        body: JSON.stringify({ isPinned: false }),
      });
      ok('conversation prefs pin/unpin');
    } catch (e) {
      fail('conversation prefs', e);
    }
  }

  // ── Messages ────────────────────────────────────────────
  console.log('\n5. Messages');
  let sent = null;
  if (!direct?.id) {
    fail('send text message', 'skipped — no direct conversation id');
    fail('list messages', 'skipped — no direct conversation id');
  } else {
    try {
      // App uses multipart FormData (multer on the route) — match real client
      const form = new FormData();
      form.append('content', `smoke-test ${Date.now()}`);
      form.append('type', 'text');
      const raw = await api(`/messages/conversation/${direct.id}`, {
        method: 'POST',
        headers: authA,
        body: form,
      });
      sent = asMessage(raw);
      if (!sent?.id) {
        throw new Error(
          `send returned no message.id — keys: ${Object.keys(raw || {}).join(',')}`
        );
      }
      ok('send text message', sent.id);
    } catch (e) {
      fail('send text message', e);
    }

    try {
      const page = await api(`/messages/conversation/${direct.id}?limit=20`, {
        headers: authA,
      });
      const msgs = Array.isArray(page) ? page : page.messages || page.data || [];
      if (!msgs.length && !sent?.id) {
        throw new Error('expected at least one message after send');
      }
      ok('list messages', `n=${msgs.length}`);
    } catch (e) {
      fail('list messages', e);
    }

    if (!sent?.id) {
      fail('edit message', 'skipped — no sent message id');
      fail('react to message', 'skipped — no sent message id');
      fail('star message', 'skipped — no sent message id');
    } else {
      try {
        await api(`/messages/${sent.id}`, {
          method: 'PATCH',
          headers: authA,
          body: JSON.stringify({ content: `edited ${Date.now()}` }),
        });
        ok('edit message');
      } catch (e) {
        fail('edit message', e);
      }

      try {
        await api(`/messages/${sent.id}/react`, {
          method: 'POST',
          headers: authB,
          body: JSON.stringify({ emoji: '👍' }),
        });
        ok('react to message');
      } catch (e) {
        fail('react to message', e);
      }

      try {
        await api(`/messages/${sent.id}/star`, {
          method: 'POST',
          headers: authA,
        });
        ok('star message');
      } catch (e) {
        fail('star message', e);
      }
    }
  }

  // ── Notifications / calls history ───────────────────────
  console.log('\n6. Notifications & call history');
  try {
    const n = await api('/notifications', { headers: authA });
    ok('list notifications', `type=${typeof n}`);
  } catch (e) {
    fail('list notifications', e);
  }

  try {
    const c = await api('/calls/history', { headers: authA });
    const list = Array.isArray(c) ? c : c.calls || [];
    ok('call history', `n=${list.length}`);
  } catch (e) {
    try {
      const c = await api('/calls', { headers: authA });
      ok('call history (alt)', typeof c);
    } catch (e2) {
      fail('call history', e2);
    }
  }

  // ── Sessions ────────────────────────────────────────────
  console.log('\n7. Sessions');
  try {
    const s = await api('/auth/sessions', { headers: authA });
    const list = Array.isArray(s) ? s : s.sessions || [];
    ok('list sessions', `n=${list.length}`);
  } catch (e) {
    fail('list sessions', e);
  }

  // ── Upload ──────────────────────────────────────────────
  console.log('\n8. Upload');
  try {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const form = new FormData();
    form.append('files', new Blob([png], { type: 'image/png' }), 'pixel.png');
    const res = await fetch(`${API}/api/uploads`, {
      method: 'POST',
      headers: authA,
      body: form,
    });
    const json = await res.json();
    if (!res.ok || json.success === false) {
      throw new Error(JSON.stringify(json.error || json));
    }
    ok('upload image', 'via /uploads');
  } catch (e) {
    fail('upload image', e);
  }

  // ── Settings + 2FA status + block list ───────────────────
  console.log('\n8b. Settings / moderation');
  try {
    await api('/users/me/settings', {
      method: 'PATCH',
      headers: authA,
      body: JSON.stringify({ theme: 'system' }),
    });
    ok('update settings theme');
  } catch (e) {
    fail('update settings', e);
  }
  try {
    const s2 = await api('/auth/2fa/status', { headers: authA });
    ok('2fa status', JSON.stringify(s2).slice(0, 60));
  } catch (e) {
    fail('2fa status', e);
  }
  try {
    const bl = await api('/users/me/blocked', { headers: authA });
    ok('list blocked', `n=${Array.isArray(bl) ? bl.length : '?'}`);
  } catch (e) {
    fail('list blocked', e);
  }
  try {
    await api(`/users/${bob.user.id}/keys`, { headers: authA });
    ok('get peer identity keys');
  } catch (e) {
    fail('get peer identity keys', e);
  }

  // ── Socket presence + messaging ─────────────────────────
  console.log('\n9. Socket realtime');
  let sa, sb;
  try {
    sa = await connectSocket(alice.accessToken);
    sb = await connectSocket(bob.accessToken);
    ok('socket connect alice+bob', `${sa.id} / ${sb.id}`);
  } catch (e) {
    fail('socket connect', e);
  }

  if (sa && sb) {
    if (!direct?.id) {
      fail('REST send → socket message:new', 'skipped — no direct conversation id');
    } else {
      try {
        // Messages are sent via REST FormData; sockets deliver message:new
        const got = once(sb, 'message:new', 8000);
        const form = new FormData();
        form.append('content', `socket-smoke ${Date.now()}`);
        form.append('type', 'text');
        await api(`/messages/conversation/${direct.id}`, {
          method: 'POST',
          headers: authA,
          body: form,
        });
        const msg = await got;
        const mid = msg?.id || msg?._id || (msg?.message && (msg.message.id || msg.message._id));
        if (!mid) throw new Error('message:new payload missing id');
        ok('REST send → socket message:new', String(mid));
      } catch (e) {
        fail('REST send → socket message:new', e);
      }
    }

    try {
      sa.emit('presence:ping');
      ok('presence:ping emit');
    } catch (e) {
      fail('presence:ping', e);
    }
  }

  // ── Call signaling ──────────────────────────────────────
  console.log('\n10. Call signaling');
  if (sa && sb) {
    if (!direct?.id) {
      fail('call signaling 1:1', 'skipped — no direct conversation id');
    } else {
      try {
        const incoming = once(sb, 'call:incoming', 6000);
        const callId = `smoke_${Date.now()}`;
        sa.emit('call:initiate', {
          conversationId: direct.id,
          targetUserId: bob.user.id,
          callType: 'audio',
          callId,
          preferRelay: true,
          sdpOffer: {
            type: 'offer',
            sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Pulse\r\nt=0 0\r\n',
          },
        });
        const payload = await incoming;
        if (!payload.callId) throw new Error('no callId on call:incoming');
        ok('call:initiate → call:incoming', payload.callId);

        const answered = once(sa, 'call:answer', 5000);
        sb.emit('call:accept', {
          targetUserId: alice.user.id,
          callId: payload.callId,
          preferRelay: true,
          sdpAnswer: {
            type: 'answer',
            sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Pulse\r\nt=0 0\r\n',
          },
        });
        await answered;
        ok('call:accept → call:answer');

        sa.emit('call:end', {
          targetUserId: bob.user.id,
          callId: payload.callId,
        });
        ok('call:end emit');
      } catch (e) {
        fail('call signaling 1:1', e);
      }
    }

    // Group call if group exists
    if (!group?.id) {
      fail('group call signaling', 'skipped — no group id');
    } else {
      try {
        const gin = once(sb, 'call:group:incoming', 6000);
        const gcallId = `gsmoke_${Date.now()}`;
        sa.emit('call:group:start', {
          conversationId: group.id,
          inviteUserIds: [bob.user.id],
          callType: 'audio',
          callId: gcallId,
        });
        const gp = await gin;
        ok('call:group:start → incoming', gp.callId || gcallId);

        sb.emit('call:group:accept', { callId: gp.callId || gcallId });
        await new Promise((r) => setTimeout(r, 400));
        sa.emit('call:group:leave', { callId: gp.callId || gcallId });
        sb.emit('call:group:leave', { callId: gp.callId || gcallId });
        ok('group call accept + leave');
      } catch (e) {
        fail('group call signaling', e);
      }
    }
  }

  // ── Unauthorized access ─────────────────────────────────
  console.log('\n11. Auth guards');
  try {
    await api('/conversations?filter=all');
    fail('unauth conversations blocked', 'expected 401');
  } catch (e) {
    if (e.status === 401 || /auth|token|unauthorized/i.test(e.message)) {
      ok('unauth conversations blocked');
    } else fail('unauth conversations blocked', e);
  }

  // ── Cleanup sockets ─────────────────────────────────────
  try {
    sa?.disconnect();
    sb?.disconnect();
  } catch {
    /* */
  }

  // ── Summary ─────────────────────────────────────────────
  console.log('\n══════════════════════════════════════');
  const pass = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`Results: ${pass}/${total} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}: ${r.detail}`));
  }
  console.log('══════════════════════════════════════\n');

  // write report
  const reportPath = path.join(__dirname, '..', 'logs', 'smoke-test-report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    JSON.stringify({ at: new Date().toISOString(), pass, total, failed, results }, null, 2)
  );
  console.log(`Report: ${reportPath}`);

  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal', e);
  process.exit(1);
});
