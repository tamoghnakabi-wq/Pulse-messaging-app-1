/**
 * Messaging semantics — delivery bookkeeping, idempotency, pagination and
 * view-once. Several of these are regression tests for concurrency bugs fixed
 * during the production-readiness audit; they are written to fail against the
 * previous read-modify-write implementations.
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

async function freshConversation(): Promise<string> {
  // Direct chats are unique per pair, so isolate with a throwaway partner
  const partner = await createUser(ctx);
  return createDirectConversation(ctx, alice, partner);
}

describe('send', () => {
  test('rejects an empty message', async () => {
    const convId = await createDirectConversation(ctx, alice, bob);
    const res = await apiCall(ctx, `/messages/conversation/${convId}`, {
      method: 'POST',
      token: alice.token,
      body: { content: '   ' },
    });
    assert.equal(res.status, 400);
  });

  test('is idempotent for a repeated clientId', async () => {
    const convId = await freshConversation();
    const clientId = `idem-${Date.now()}`;
    const body = { content: 'only once', clientId };

    const first = await apiCall<{ message: { id: string } }>(
      ctx,
      `/messages/conversation/${convId}`,
      { method: 'POST', token: alice.token, body }
    );
    const second = await apiCall<{ message: { id: string } }>(
      ctx,
      `/messages/conversation/${convId}`,
      { method: 'POST', token: alice.token, body }
    );

    assert.equal(first.status, 201);
    assert.equal(second.status, 200, 'retry should return the existing message, not create one');
    assert.equal(
      first.body.data?.message.id,
      second.body.data?.message.id,
      'retry created a duplicate message'
    );
  });

  test('increments the recipient unread count', async () => {
    const convId = await createDirectConversation(ctx, alice, bob);
    await apiCall(ctx, `/conversations/${convId}/read`, { method: 'POST', token: bob.token });

    await sendMessage(ctx, alice, convId, 'unread me');

    const list = await apiCall<{ conversations: { id: string; unreadCount: number }[] }>(
      ctx,
      '/conversations',
      { token: bob.token }
    );
    const row = list.body.data?.conversations.find((c) => c.id === convId);
    assert.ok((row?.unreadCount || 0) >= 1, 'unread count did not increase');
  });

  test('marking read clears the unread count', async () => {
    const convId = await createDirectConversation(ctx, alice, bob);
    await sendMessage(ctx, alice, convId, 'to be read');
    await apiCall(ctx, `/conversations/${convId}/read`, { method: 'POST', token: bob.token });

    const list = await apiCall<{ conversations: { id: string; unreadCount: number }[] }>(
      ctx,
      '/conversations',
      { token: bob.token }
    );
    const row = list.body.data?.conversations.find((c) => c.id === convId);
    assert.equal(row?.unreadCount || 0, 0);
  });

  test('a concurrent send is not lost when the peer marks read', async () => {
    // Regression: markRead used a whole-document save, so a simultaneous
    // sendMessage $inc on another participant could be clobbered.
    const convId = await createDirectConversation(ctx, alice, bob);
    await apiCall(ctx, `/conversations/${convId}/read`, { method: 'POST', token: bob.token });

    await Promise.all([
      sendMessage(ctx, alice, convId, 'racing message'),
      apiCall(ctx, `/conversations/${convId}/read`, { method: 'POST', token: bob.token }),
    ]);

    const messages = await apiCall<{ messages: { content: string }[] }>(
      ctx,
      `/messages/conversation/${convId}?limit=80`,
      { token: bob.token }
    );
    assert.ok(
      messages.body.data?.messages.some((m) => m.content === 'racing message'),
      'the message sent during markRead disappeared'
    );
  });
});

describe('pagination', () => {
  test('pages through messages that share a timestamp without loss or repeats', async () => {
    // Regression: the cursor compared createdAt only, while the sort key is
    // (createdAt, _id) — every message in the cursor's millisecond was skipped.
    const convId = await freshConversation();
    const total = 15;
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        apiCall(ctx, `/messages/conversation/${convId}`, {
          method: 'POST',
          token: alice.token,
          body: { content: `burst-${i}`, clientId: `burst-${Date.now()}-${i}` },
        })
      )
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const q = `?limit=3${cursor ? `&before=${cursor}` : ''}`;
      const res = await apiCall<{
        messages: { id: string }[];
        hasMore: boolean;
        nextCursor: string | null;
      }>(ctx, `/messages/conversation/${convId}${q}`, { token: alice.token });
      seen.push(...(res.body.data?.messages || []).map((m) => m.id));
      if (!res.body.data?.hasMore || !res.body.data.nextCursor) break;
      cursor = res.body.data.nextCursor;
    }

    assert.equal(new Set(seen).size, seen.length, 'pagination returned duplicate messages');
    assert.equal(seen.length, total, `pagination reached ${seen.length} of ${total} messages`);
  });

  test('caps the page size', async () => {
    const convId = await freshConversation();
    const res = await apiCall<{ messages: unknown[] }>(
      ctx,
      `/messages/conversation/${convId}?limit=9999`,
      { token: alice.token }
    );
    assert.equal(res.status, 200);
    assert.ok((res.body.data?.messages.length || 0) <= 80);
  });
});

describe('view once', () => {
  test('a second open returns no media', async () => {
    const convId = await createDirectConversation(ctx, alice, bob);
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
        '1f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
      'hex'
    );
    const form = new FormData();
    form.append('files', new Blob([png], { type: 'image/png' }), 'once.png');
    form.append('viewOnce', 'true');
    form.append('type', 'image');

    const sendRes = await fetch(`${ctx.baseUrl}/api/messages/conversation/${convId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
      body: form,
    });
    assert.equal(sendRes.status, 201);
    const sent = (await sendRes.json()) as { data: { message: { id: string } } };
    const msgId = sent.data.message.id;

    const first = await apiCall<{ media?: unknown[]; alreadyOpened?: boolean }>(
      ctx,
      `/messages/${msgId}/view-once`,
      { method: 'POST', token: bob.token }
    );
    assert.equal(first.status, 200);
    assert.ok((first.body.data?.media?.length || 0) > 0, 'first open returned no media');

    const second = await apiCall<{ media?: unknown[]; alreadyOpened?: boolean }>(
      ctx,
      `/messages/${msgId}/view-once`,
      { method: 'POST', token: bob.token }
    );
    assert.equal(second.body.data?.alreadyOpened, true);
    assert.equal(second.body.data?.media?.length || 0, 0, 'media served twice');
  });

  test('concurrent opens hand out media exactly once', async () => {
    // Regression: read-then-write let every parallel request pass the
    // "already viewed" check and receive the media.
    const convId = await createDirectConversation(ctx, alice, bob);
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
        '1f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
      'hex'
    );
    const form = new FormData();
    form.append('files', new Blob([png], { type: 'image/png' }), 'race.png');
    form.append('viewOnce', 'true');
    form.append('type', 'image');

    const sendRes = await fetch(`${ctx.baseUrl}/api/messages/conversation/${convId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
      body: form,
    });
    const sent = (await sendRes.json()) as { data: { message: { id: string } } };
    const msgId = sent.data.message.id;

    const opens = await Promise.all(
      Array.from({ length: 6 }, () =>
        apiCall<{ media?: unknown[] }>(ctx, `/messages/${msgId}/view-once`, {
          method: 'POST',
          token: bob.token,
        })
      )
    );
    const withMedia = opens.filter((r) => (r.body.data?.media?.length || 0) > 0);
    assert.equal(withMedia.length, 1, `${withMedia.length} of 6 concurrent opens received media`);
  });
});

describe('forward', () => {
  test('forwarding bumps the recipient unread count', async () => {
    // Regression: forward only set lastMessage, so it arrived with no badge.
    const source = await createDirectConversation(ctx, alice, bob);
    const msg = await sendMessage(ctx, alice, source, 'forward payload');

    await apiCall(ctx, `/conversations/${source}/read`, { method: 'POST', token: bob.token });
    const before = await apiCall<{ conversations: { id: string; unreadCount: number }[] }>(
      ctx,
      '/conversations',
      { token: bob.token }
    );
    const beforeCount =
      before.body.data?.conversations.find((c) => c.id === source)?.unreadCount || 0;

    const fwd = await apiCall(ctx, `/messages/${msg.id}/forward`, {
      method: 'POST',
      token: alice.token,
      body: { conversationIds: [source] },
    });
    assert.equal(fwd.status, 201);

    const after = await apiCall<{ conversations: { id: string; unreadCount: number }[] }>(
      ctx,
      '/conversations',
      { token: bob.token }
    );
    const afterCount =
      after.body.data?.conversations.find((c) => c.id === source)?.unreadCount || 0;
    assert.ok(afterCount > beforeCount, `unread did not increase (${beforeCount} → ${afterCount})`);
  });

  test('cannot forward a message from a conversation you are not in', async () => {
    const outsider = await createUser(ctx);
    const source = await createDirectConversation(ctx, alice, bob);
    const msg = await sendMessage(ctx, alice, source, 'not yours');

    const res = await apiCall(ctx, `/messages/${msg.id}/forward`, {
      method: 'POST',
      token: outsider.token,
      body: { conversationIds: [source] },
    });
    assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
  });
});

describe('blocking', () => {
  test('a blocked user cannot send a direct message', async () => {
    const target = await createUser(ctx);
    const convId = await createDirectConversation(ctx, alice, target);

    const blocked = await apiCall(ctx, `/users/me/blocked/${alice.id}`, {
      method: 'POST',
      token: target.token,
    });
    assert.ok(blocked.status < 400, `block failed: ${JSON.stringify(blocked.body)}`);

    const res = await sendMessage(ctx, alice, convId, 'should be blocked');
    assert.equal(res.status, 403);
  });

  test('blocking cannot be bypassed by forwarding', async () => {
    // Regression: sendMessage enforced isEitherBlocked, forwardMessage did not.
    const target = await createUser(ctx);
    const convId = await createDirectConversation(ctx, alice, target);
    const carrier = await createDirectConversation(ctx, alice, bob);
    const msg = await sendMessage(ctx, alice, carrier, 'forward bypass attempt');

    await apiCall(ctx, `/users/me/blocked/${alice.id}`, { method: 'POST', token: target.token });

    const res = await apiCall<{ messages: unknown[] }>(ctx, `/messages/${msg.id}/forward`, {
      method: 'POST',
      token: alice.token,
      body: { conversationIds: [convId] },
    });
    // The blocked target must be skipped rather than delivered to
    assert.equal(res.body.data?.messages.length || 0, 0, 'forward delivered to a blocking user');

    const inbox = await apiCall<{ messages: { content: string }[] }>(
      ctx,
      `/messages/conversation/${convId}?limit=80`,
      { token: target.token }
    );
    assert.ok(
      !inbox.body.data?.messages.some((m) => m.content === 'forward bypass attempt'),
      'blocked message was delivered via forward'
    );
  });
});
