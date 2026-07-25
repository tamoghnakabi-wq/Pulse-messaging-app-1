/**
 * Multi-instance (clustered) verification.
 *
 * Proves that two API instances sharing one Redis behave as a single logical
 * server: Alice's socket lives on instance A, Bob's on instance B, and every
 * assertion below fails without the Socket.IO Redis adapter + presence mirror.
 *
 * Prerequisites — two API processes against the same Mongo *and* the same Redis:
 *
 *   docker run -d -p 27017:27017 mongo:7
 *   docker run -d -p 6379:6379 redis:7-alpine
 *   # then, from backend/ with the usual JWT_* secrets exported:
 *   PORT=5071 INSTANCE_ID=A REDIS_URL=redis://127.0.0.1:6379 node dist/server.js &
 *   PORT=5072 INSTANCE_ID=B REDIS_URL=redis://127.0.0.1:6379 node dist/server.js &
 *   npm run test:cluster
 *
 * Override endpoints with CLUSTER_A_URL / CLUSTER_B_URL. Note that ports 5060
 * and 5061 are on the WHATWG "bad ports" blocklist and cannot be used here.
 */
import { io } from 'socket.io-client';

const A = process.env.CLUSTER_A_URL || 'http://127.0.0.1:5071';
const B = process.env.CLUSTER_B_URL || 'http://127.0.0.1:5072';
const PW = process.env.CLUSTER_PASSWORD || 'ClusterTest_9xy';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  ✓ ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); };

async function api(base, path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, data: json.data, error: json.error };
}

async function makeUser(base, tag) {
  const username = `cl${tag}${Date.now().toString(36).slice(-5)}`.toLowerCase();
  const r = await api(base, '/auth/register', {
    method: 'POST',
    body: { username, email: `${username}@example.test`, password: PW, displayName: username },
  });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.error)}`);
  return { id: r.data.user.id, username, token: r.data.accessToken };
}

function connect(base, token) {
  return new Promise((resolve, reject) => {
    const s = io(base, { transports: ['websocket'], auth: { token }, reconnection: false });
    const t = setTimeout(() => reject(new Error(`socket timeout ${base}`)), 10000);
    s.on('connect', () => { clearTimeout(t); resolve(s); });
    s.on('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
}

function waitFor(socket, event, ms = 8000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    socket.once(event, (payload) => { clearTimeout(t); resolve(payload); });
  });
}

const run = async () => {
  console.log('\nCross-instance delivery (A :5071  ·  B :5072)\n');

  const alice = await makeUser(A, 'a');
  const bob = await makeUser(B, 'b');

  // Alice's socket lives on A, Bob's on B
  const aliceSock = await connect(A, alice.token);
  const bobSock = await connect(B, bob.token);
  ok('sockets connected to different instances');

  const conv = await api(A, '/conversations/direct', {
    method: 'POST', token: alice.token, body: { userId: bob.id },
  });
  const convId = conv.data.conversation.id;

  // Give the presence snapshot a tick to propagate through Redis
  await new Promise((r) => setTimeout(r, 9000));

  // 1. message:new must cross the instance boundary
  const inbound = waitFor(bobSock, 'message:new');
  const sent = await api(A, `/messages/conversation/${convId}`, {
    method: 'POST', token: alice.token,
    body: { content: 'hello across instances', clientId: `cl-${Date.now()}` },
  });
  if (sent.status !== 201) bad('send message', JSON.stringify(sent.error));
  const received = await inbound;
  if (received?.content === 'hello across instances') {
    ok('message sent on A delivered to socket on B');
  } else {
    bad('message did not cross instances', JSON.stringify(received)?.slice(0, 120));
  }

  // 2. per-user room events must also cross (notification:message)
  const notif = waitFor(bobSock, 'notification:message');
  await api(A, `/messages/conversation/${convId}`, {
    method: 'POST', token: alice.token,
    body: { content: 'notify across', clientId: `cl-n-${Date.now()}` },
  });
  if (await notif) ok('user-room notification crossed instances');
  else bad('user-room notification did not cross instances');

  // 3. typing indicators (conversation room, socket-scoped broadcast)
  const typing = waitFor(bobSock, 'typing:start', 6000);
  aliceSock.emit('conversation:join', convId);
  bobSock.emit('conversation:join', convId);
  await new Promise((r) => setTimeout(r, 400));
  aliceSock.emit('typing:start', { conversationId: convId });
  if (await typing) ok('typing indicator crossed instances');
  else bad('typing indicator did not cross instances');

  // 4. presence mirror: B must see Alice (connected only to A) as online
  const seen = await api(B, `/users/${alice.id}`, { token: bob.token });
  if (seen.data?.user?.isOnline === true) {
    ok('instance B reports a user connected to A as online');
  } else {
    bad('presence mirror failed', `isOnline=${seen.data?.user?.isOnline}`);
  }

  // 5. call signaling across instances
  const ring = waitFor(bobSock, 'call:incoming', 6000);
  aliceSock.emit('call:initiate', {
    targetUserId: bob.id, conversationId: convId, callType: 'audio', callId: `cc-${Date.now()}`,
  });
  if (await ring) ok('call signaling crossed instances');
  else bad('call signaling did not cross instances');

  aliceSock.close();
  bobSock.close();
  console.log(`\n${'='.repeat(44)}\nResults: ${pass} passed, ${fail} failed\n${'='.repeat(44)}`);
  process.exit(fail ? 1 : 0);
};

run().catch((e) => {
  console.error('harness error:', e.message);
  console.error(`\nAre both instances up at ${A} and ${B} with a shared REDIS_URL?`);
  process.exit(1);
});
