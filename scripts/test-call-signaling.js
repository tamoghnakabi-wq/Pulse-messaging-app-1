/**
 * Smoke-test Socket.IO call signaling between two users (no media).
 * Usage: node scripts/test-call-signaling.js
 */
const { io } = require('socket.io-client');

const API = process.env.API_URL || 'http://127.0.0.1:5050';

async function api(path, opts = {}) {
  const res = await fetch(`${API}/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const json = await res.json();
  if (!json.success) throw new Error(JSON.stringify(json.error || json));
  return json.data;
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(API, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      auth: { token },
    });
    const t = setTimeout(() => reject(new Error('socket timeout')), 10000);
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

async function main() {
  console.log('API', API);

  const a = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ emailOrUsername: 'alice', password: 'Password1' }),
  });
  const b = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ emailOrUsername: 'bob', password: 'Password1' }),
  });

  console.log('alice', a.user.id, 'bob', b.user.id);

  const sa = await connect(a.accessToken);
  const sb = await connect(b.accessToken);
  console.log('sockets connected', sa.id, sb.id);

  const incoming = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no call:incoming within 5s')), 5000);
    sb.on('call:incoming', (p) => {
      clearTimeout(t);
      resolve(p);
    });
  });

  const fakeOffer = {
    type: 'offer',
    sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
  };

  sa.emit('call:initiate', {
    conversationId: '000000000000000000000000',
    targetUserId: b.user.id,
    callType: 'audio',
    callId: 'test-call-1',
    sdpOffer: fakeOffer,
  });

  const payload = await incoming;
  console.log('SUCCESS call:incoming received by bob:', {
    fromUserId: payload.fromUserId,
    callId: payload.callId,
    callType: payload.callType,
    hasOffer: !!payload.sdpOffer,
  });

  // Test accept → answer (single event)
  const answered = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no call:answer within 5s')), 5000);
    let count = 0;
    sa.on('call:answer', (p) => {
      count += 1;
      if (count === 1) {
        clearTimeout(t);
        resolve({ ...p, _count: count });
      }
    });
    // Must NOT fire call:accepted anymore
    sa.on('call:accepted', () => {
      reject(new Error('unexpected call:accepted (duplicate path)'));
    });
  });

  sb.emit('call:accept', {
    targetUserId: a.user.id,
    callId: payload.callId,
    sdpAnswer: { type: 'answer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' },
  });

  const ans = await answered;
  console.log('SUCCESS call answer received by alice:', {
    fromUserId: ans.fromUserId,
    hasAnswer: !!ans.sdpAnswer,
  });

  sa.disconnect();
  sb.disconnect();
  console.log('All call signaling tests passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL', e.message || e);
  process.exit(1);
});
