/**
 * Authorization boundaries.
 *
 * Every one of these asserts that a *valid* session for user A cannot act on
 * user B's data — the failure mode that matters most in a messaging product.
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
let mallory: TestUser;
let convId: string;

before(async () => {
  ctx = await startTestApp();
  alice = await createUser(ctx);
  bob = await createUser(ctx);
  mallory = await createUser(ctx);
  convId = await createDirectConversation(ctx, alice, bob);
});

after(async () => {
  await ctx.close();
});

describe('conversation access', () => {
  test('an outsider cannot read the conversation', async () => {
    const res = await apiCall(ctx, `/conversations/${convId}`, { token: mallory.token });
    assert.equal(res.status, 404);
  });

  test('an outsider cannot list its messages', async () => {
    const res = await apiCall(ctx, `/messages/conversation/${convId}`, {
      token: mallory.token,
    });
    assert.equal(res.status, 404);
  });

  test('an outsider cannot post into it', async () => {
    const res = await sendMessage(ctx, mallory, convId, 'intruding');
    assert.equal(res.status, 404);
  });

  test('an outsider cannot mark it read', async () => {
    const res = await apiCall(ctx, `/conversations/${convId}/read`, {
      method: 'POST',
      token: mallory.token,
    });
    assert.equal(res.status, 404);
  });

  test('participants can read it', async () => {
    for (const user of [alice, bob]) {
      const res = await apiCall(ctx, `/conversations/${convId}`, { token: user.token });
      assert.equal(res.status, 200);
    }
  });

  test('rejects a malformed conversation id instead of 500ing', async () => {
    const res = await apiCall(ctx, '/messages/conversation/not-an-object-id', {
      token: alice.token,
    });
    assert.ok(res.status === 400 || res.status === 404, `got ${res.status}`);
    assert.notEqual(res.status, 500);
  });
});

describe('message ownership', () => {
  test('only the sender may edit', async () => {
    const msg = await sendMessage(ctx, alice, convId, 'alice original');

    const byBob = await apiCall(ctx, `/messages/${msg.id}`, {
      method: 'PATCH',
      token: bob.token,
      body: { content: 'bob tampered' },
    });
    assert.equal(byBob.status, 403);

    const byAlice = await apiCall(ctx, `/messages/${msg.id}`, {
      method: 'PATCH',
      token: alice.token,
      body: { content: 'alice edited' },
    });
    assert.equal(byAlice.status, 200);
  });

  test('only the sender may delete for everyone', async () => {
    const msg = await sendMessage(ctx, alice, convId, 'delete target');
    const byBob = await apiCall(ctx, `/messages/${msg.id}/everyone`, {
      method: 'DELETE',
      token: bob.token,
    });
    assert.equal(byBob.status, 403);

    const byAlice = await apiCall(ctx, `/messages/${msg.id}/everyone`, {
      method: 'DELETE',
      token: alice.token,
    });
    assert.equal(byAlice.status, 200);
  });

  test('an outsider cannot react to a message in a chat they are not in', async () => {
    const msg = await sendMessage(ctx, alice, convId, 'react target');
    const res = await apiCall(ctx, `/messages/${msg.id}/react`, {
      method: 'POST',
      token: mallory.token,
      body: { emoji: '👍' },
    });
    assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
  });

  test('an outsider cannot star a message they cannot see', async () => {
    const msg = await sendMessage(ctx, alice, convId, 'star target');
    const res = await apiCall(ctx, `/messages/${msg.id}/star`, {
      method: 'POST',
      token: mallory.token,
    });
    assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
  });

  test('delete-for-me hides the message only for that user', async () => {
    const msg = await sendMessage(ctx, alice, convId, 'per-user delete');

    const del = await apiCall(ctx, `/messages/${msg.id}/me`, {
      method: 'DELETE',
      token: bob.token,
    });
    assert.equal(del.status, 200);

    const bobView = await apiCall<{ messages: { id: string }[] }>(
      ctx,
      `/messages/conversation/${convId}?limit=80`,
      { token: bob.token }
    );
    const aliceView = await apiCall<{ messages: { id: string }[] }>(
      ctx,
      `/messages/conversation/${convId}?limit=80`,
      { token: alice.token }
    );
    assert.ok(!bobView.body.data?.messages.some((m) => m.id === msg.id), 'bob still sees it');
    assert.ok(aliceView.body.data?.messages.some((m) => m.id === msg.id), 'alice lost it');
  });
});

describe('group permissions', () => {
  test('a non-admin member cannot rename the group', async () => {
    const group = await apiCall<{ conversation: { id: string } }>(ctx, '/conversations/group', {
      method: 'POST',
      token: alice.token,
      body: { name: 'Test Group', participantIds: [bob.id] },
    });
    const groupId = group.body.data?.conversation.id as string;
    assert.ok(groupId);

    const byMember = await apiCall(ctx, `/conversations/${groupId}`, {
      method: 'PATCH',
      token: bob.token,
      body: { name: 'Hijacked' },
    });
    assert.equal(byMember.status, 403);

    const byOwner = await apiCall(ctx, `/conversations/${groupId}`, {
      method: 'PATCH',
      token: alice.token,
      body: { name: 'Renamed By Owner' },
    });
    assert.equal(byOwner.status, 200);
  });

  test('only the owner may delete the group', async () => {
    const group = await apiCall<{ conversation: { id: string } }>(ctx, '/conversations/group', {
      method: 'POST',
      token: alice.token,
      body: { name: 'Doomed Group', participantIds: [bob.id] },
    });
    const groupId = group.body.data?.conversation.id as string;

    assert.equal(
      (await apiCall(ctx, `/conversations/${groupId}`, { method: 'DELETE', token: bob.token }))
        .status,
      403
    );
    assert.equal(
      (await apiCall(ctx, `/conversations/${groupId}`, { method: 'DELETE', token: alice.token }))
        .status,
      200
    );
  });

  test('the owner cannot be removed from their own group', async () => {
    const group = await apiCall<{ conversation: { id: string } }>(ctx, '/conversations/group', {
      method: 'POST',
      token: alice.token,
      body: { name: 'Owner Guard', participantIds: [bob.id] },
    });
    const groupId = group.body.data?.conversation.id as string;

    const res = await apiCall(ctx, `/conversations/${groupId}/participants/${alice.id}`, {
      method: 'DELETE',
      token: alice.token,
    });
    assert.equal(res.status, 400);
  });
});

describe('privacy', () => {
  test('user search never matches on email', async () => {
    const res = await apiCall<{ users: { id: string }[] }>(
      ctx,
      `/users/search?q=${encodeURIComponent(bob.email)}`,
      { token: mallory.token }
    );
    assert.equal(res.status, 200);
    assert.ok(
      !res.body.data?.users.some((u) => u.id === bob.id),
      'email lookup exposed a user'
    );
  });

  test('a stranger does not receive another user\'s email', async () => {
    const res = await apiCall<{ user: { email?: string } }>(ctx, `/users/${bob.id}`, {
      token: mallory.token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data?.user.email, undefined);
  });
});
