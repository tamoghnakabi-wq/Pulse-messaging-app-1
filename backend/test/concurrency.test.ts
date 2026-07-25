/**
 * Concurrency and input-validation guards.
 *
 * These exercise the paths that were read-modify-write before the audit: run
 * two clients at the same instant and assert neither update is lost.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestApp,
  apiCall,
  createUser,
  createDirectConversation,
  sendMessage,
  type TestContext,
  type TestUser,
} from './helpers/harness';

let ctx: TestContext;
let alice: TestUser;
let bob: TestUser;

before(async () => {
  ctx = await startTestApp();
  alice = await createUser(ctx);
  bob = await createUser(ctx);
});

after(async () => {
  await ctx.close();
});

interface ReactionDto {
  emoji: string;
  users: string[] | { id?: string }[];
}

describe('reactions', () => {
  test('simultaneous reactions from two users are both kept', async () => {
    // Regression: reactions were rewritten as a whole array, so the slower
    // writer silently clobbered the faster one.
    const convId = await createDirectConversation(ctx, alice, bob);
    const msg = await sendMessage(ctx, alice, convId, 'react to me');

    await Promise.all([
      apiCall(ctx, `/messages/${msg.id}/react`, {
        method: 'POST',
        token: alice.token,
        body: { emoji: '👍' },
      }),
      apiCall(ctx, `/messages/${msg.id}/react`, {
        method: 'POST',
        token: bob.token,
        body: { emoji: '🎉' },
      }),
    ]);

    const list = await apiCall<{ messages: { id: string; reactions: ReactionDto[] }[] }>(
      ctx,
      `/messages/conversation/${convId}?limit=80`,
      { token: alice.token }
    );
    const stored = list.body.data?.messages.find((m) => m.id === msg.id);
    const emojis = (stored?.reactions || []).map((r) => r.emoji).sort();
    assert.deepEqual(emojis, ['🎉', '👍'], `lost a reaction: got ${JSON.stringify(emojis)}`);
  });

  test('reacting twice with the same emoji toggles it off', async () => {
    const convId = await createDirectConversation(ctx, alice, bob);
    const msg = await sendMessage(ctx, alice, convId, 'toggle me');

    const body = { emoji: '🔥' };
    await apiCall(ctx, `/messages/${msg.id}/react`, {
      method: 'POST',
      token: alice.token,
      body,
    });
    await apiCall(ctx, `/messages/${msg.id}/react`, {
      method: 'POST',
      token: alice.token,
      body,
    });

    const list = await apiCall<{ messages: { id: string; reactions: ReactionDto[] }[] }>(
      ctx,
      `/messages/conversation/${convId}?limit=80`,
      { token: alice.token }
    );
    const stored = list.body.data?.messages.find((m) => m.id === msg.id);
    assert.ok(
      !(stored?.reactions || []).some((r) => r.emoji === '🔥'),
      'emoji bucket survived the un-react'
    );
  });

  test('rejects an oversized emoji payload', async () => {
    const convId = await createDirectConversation(ctx, alice, bob);
    const msg = await sendMessage(ctx, alice, convId, 'bad emoji target');
    const res = await apiCall(ctx, `/messages/${msg.id}/react`, {
      method: 'POST',
      token: alice.token,
      body: { emoji: 'x'.repeat(500) },
    });
    assert.equal(res.status, 400);
  });
});

describe('direct conversation creation', () => {
  test('concurrent opens converge on a single conversation', async () => {
    // Regression: check-then-create let both sides create their own thread.
    const one = await createUser(ctx);
    const two = await createUser(ctx);

    const results = await Promise.all([
      apiCall<{ conversation: { id: string } }>(ctx, '/conversations/direct', {
        method: 'POST',
        token: one.token,
        body: { userId: two.id },
      }),
      apiCall<{ conversation: { id: string } }>(ctx, '/conversations/direct', {
        method: 'POST',
        token: two.token,
        body: { userId: one.id },
      }),
      apiCall<{ conversation: { id: string } }>(ctx, '/conversations/direct', {
        method: 'POST',
        token: one.token,
        body: { userId: two.id },
      }),
    ]);

    const ids = new Set(
      results.map((r) => r.body.data?.conversation?.id).filter(Boolean) as string[]
    );
    assert.equal(ids.size, 1, `created ${ids.size} conversations for one pair`);

    const list = await apiCall<{ conversations: { id: string; type: string }[] }>(
      ctx,
      '/conversations',
      { token: one.token }
    );
    const directs = (list.body.data?.conversations || []).filter((c) => c.type === 'direct');
    assert.equal(directs.length, 1, 'duplicate direct chats appear in the list');
  });

  test('rejects a malformed user id with 400, not 500', async () => {
    const res = await apiCall(ctx, '/conversations/direct', {
      method: 'POST',
      token: alice.token,
      body: { userId: 'not-an-object-id' },
    });
    assert.equal(res.status, 400);
  });

  test('refuses a chat with yourself', async () => {
    const res = await apiCall(ctx, '/conversations/direct', {
      method: 'POST',
      token: alice.token,
      body: { userId: alice.id },
    });
    assert.equal(res.status, 400);
  });
});

describe('group membership guards', () => {
  test('rejects participants that do not exist', async () => {
    const res = await apiCall(ctx, '/conversations/group', {
      method: 'POST',
      token: alice.token,
      body: { name: 'Ghosts', participantIds: ['507f1f77bcf86cd799439011'] },
    });
    assert.equal(res.status, 404);
  });

  test('rejects malformed participant ids with 400, not 500', async () => {
    const res = await apiCall(ctx, '/conversations/group', {
      method: 'POST',
      token: alice.token,
      body: { name: 'Bad Ids', participantIds: ['nope'] },
    });
    assert.equal(res.status, 400);
  });

  test('addParticipants rejects unknown users', async () => {
    const group = await apiCall<{ conversation: { id: string } }>(ctx, '/conversations/group', {
      method: 'POST',
      token: alice.token,
      body: { name: 'Add Guard', participantIds: [bob.id] },
    });
    const groupId = group.body.data?.conversation.id as string;

    const res = await apiCall(ctx, `/conversations/${groupId}/participants`, {
      method: 'POST',
      token: alice.token,
      body: { userIds: ['507f1f77bcf86cd799439011'] },
    });
    assert.equal(res.status, 404);
  });

  test('adding an existing member is a no-op, not a duplicate', async () => {
    const group = await apiCall<{ conversation: { id: string } }>(ctx, '/conversations/group', {
      method: 'POST',
      token: alice.token,
      body: { name: 'Dup Guard', participantIds: [bob.id] },
    });
    const groupId = group.body.data?.conversation.id as string;

    const res = await apiCall<{ conversation: { participants: unknown[] } }>(
      ctx,
      `/conversations/${groupId}/participants`,
      { method: 'POST', token: alice.token, body: { userIds: [bob.id] } }
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.data?.conversation.participants.length, 2);
  });
});

describe('starring', () => {
  test('star then unstar leaves no residue', async () => {
    const convId = await createDirectConversation(ctx, alice, bob);
    const msg = await sendMessage(ctx, alice, convId, 'star toggle');

    const on = await apiCall<{ starred: boolean }>(ctx, `/messages/${msg.id}/star`, {
      method: 'POST',
      token: alice.token,
    });
    assert.equal(on.body.data?.starred, true);

    const off = await apiCall<{ starred: boolean }>(ctx, `/messages/${msg.id}/star`, {
      method: 'POST',
      token: alice.token,
    });
    assert.equal(off.body.data?.starred, false);

    const starred = await apiCall<{ messages: { id: string }[] }>(ctx, '/users/me/starred', {
      token: alice.token,
    });
    assert.ok(
      !(starred.body.data?.messages || []).some((m) => m.id === msg.id),
      'unstarred message still listed'
    );
  });
});

describe('observability endpoints', () => {
  test('health is always available', async () => {
    const res = await apiCall<{ status: string }>(ctx, '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.data?.status, 'ok');
  });

  test('readiness reports the database connection', async () => {
    const res = await apiCall<{ database: string }>(ctx, '/ready');
    assert.equal(res.status, 200);
    assert.equal(res.body.data?.database, 'connected');
  });

  test('responses carry a request id', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/health`);
    assert.ok(res.headers.get('x-request-id'), 'X-Request-Id header missing');
  });

  test('metrics expose http and socket series', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/metrics`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /pulse_up 1/);
    assert.match(body, /pulse_http_requests_total\{/);
    assert.match(body, /pulse_db_connected 1/);
  });
});
