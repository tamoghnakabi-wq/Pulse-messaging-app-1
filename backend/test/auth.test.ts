/**
 * Authentication and session lifecycle.
 * Covers the flows that protect every other endpoint: registration validation,
 * credential handling, lockout, refresh rotation and session revocation.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, apiCall, createUser, type TestContext } from './helpers/harness';

let ctx: TestContext;

before(async () => {
  ctx = await startTestApp();
});

after(async () => {
  await ctx.close();
});

describe('registration', () => {
  test('rejects a weak password', async () => {
    const res = await apiCall(ctx, '/auth/register', {
      method: 'POST',
      body: {
        username: 'weakpwuser',
        email: 'weakpw@example.test',
        password: 'short',
        displayName: 'Weak',
      },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
  });

  test('rejects an invalid username charset', async () => {
    const res = await apiCall(ctx, '/auth/register', {
      method: 'POST',
      body: {
        username: 'bad user!',
        email: 'baduser@example.test',
        password: 'TestPassw0rd_x9',
      },
    });
    assert.equal(res.status, 400);
  });

  test('rejects duplicates without revealing which field collided', async () => {
    const user = await createUser(ctx);
    const res = await apiCall(ctx, '/auth/register', {
      method: 'POST',
      body: {
        username: user.username,
        email: 'different@example.test',
        password: 'TestPassw0rd_x9',
      },
    });
    assert.equal(res.status, 409);
    // Must not disclose whether the email or the username was taken
    assert.doesNotMatch(String(res.body.error?.message), /username|email/i);
  });

  test('never returns the password hash', async () => {
    const user = await createUser(ctx);
    const res = await apiCall<{ user: Record<string, unknown> }>(ctx, '/auth/me', {
      token: user.token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data?.user.password, undefined);
  });
});

describe('login', () => {
  test('accepts correct credentials via username and email', async () => {
    const user = await createUser(ctx);
    for (const identifier of [user.username, user.email]) {
      const res = await apiCall<{ accessToken: string }>(ctx, '/auth/login', {
        method: 'POST',
        body: { emailOrUsername: identifier, password: user.password },
      });
      assert.equal(res.status, 200, `login failed for ${identifier}`);
      assert.ok(res.body.data?.accessToken);
    }
  });

  test('returns the same error for unknown user and wrong password', async () => {
    const user = await createUser(ctx);
    const wrongPw = await apiCall(ctx, '/auth/login', {
      method: 'POST',
      body: { emailOrUsername: user.username, password: 'WrongPassw0rd_x9' },
    });
    const unknown = await apiCall(ctx, '/auth/login', {
      method: 'POST',
      body: { emailOrUsername: 'nosuchuser_zz', password: 'WrongPassw0rd_x9' },
    });
    assert.equal(wrongPw.status, 401);
    assert.equal(unknown.status, 401);
    // Identical response shape → no account enumeration
    assert.equal(wrongPw.body.error?.code, unknown.body.error?.code);
    assert.equal(wrongPw.body.error?.message, unknown.body.error?.message);
  });

  test('locks the account after repeated failures', async () => {
    const user = await createUser(ctx);
    let locked = false;
    // MAX_FAILED_LOGINS is 8; allow headroom
    for (let i = 0; i < 10; i++) {
      const res = await apiCall(ctx, '/auth/login', {
        method: 'POST',
        body: { emailOrUsername: user.username, password: `Wrong${i}Passw0rd_x` },
      });
      if (res.status === 423) {
        locked = true;
        break;
      }
    }
    assert.ok(locked, 'account was never locked after repeated failed logins');

    // Correct password must still be refused while locked
    const afterLock = await apiCall(ctx, '/auth/login', {
      method: 'POST',
      body: { emailOrUsername: user.username, password: user.password },
    });
    assert.equal(afterLock.status, 423);
  });
});

describe('token handling', () => {
  test('rejects a malformed or absent bearer token', async () => {
    for (const token of ['', 'not-a-jwt', 'a.b.c']) {
      const res = await apiCall(ctx, '/auth/me', { token: token || undefined });
      assert.equal(res.status, 401, `token "${token}" should be rejected`);
    }
  });

  test('rejects an access token signed with the wrong secret', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const forged = jwt.sign(
      { userId: '507f1f77bcf86cd799439011', sessionId: '507f1f77bcf86cd799439012', type: 'access' },
      'attacker_secret_that_is_at_least_32_chars',
      { algorithm: 'HS256', issuer: 'pulse-api', audience: 'pulse-client', expiresIn: '15m' }
    );
    const res = await apiCall(ctx, '/auth/me', { token: forged });
    assert.equal(res.status, 401);
  });

  test('rejects a refresh token presented as an access token', async () => {
    const user = await createUser(ctx);
    const res = await apiCall(ctx, '/auth/me', { token: user.refreshToken });
    assert.equal(res.status, 401);
  });

  test('rotates the refresh token and revokes the session on reuse', async () => {
    const user = await createUser(ctx);
    const first = await apiCall<{ accessToken: string; refreshToken: string }>(
      ctx,
      '/auth/refresh',
      { method: 'POST', body: { refreshToken: user.refreshToken } }
    );
    assert.equal(first.status, 200);
    const rotated = first.body.data?.refreshToken;
    assert.ok(rotated);
    assert.notEqual(rotated, user.refreshToken, 'refresh token was not rotated');

    // Replaying the consumed token must revoke the whole session
    const replay = await apiCall(ctx, '/auth/refresh', {
      method: 'POST',
      body: { refreshToken: user.refreshToken },
    });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error?.code, 'SESSION_REVOKED');

    // ...which also invalidates the rotated token issued for that session
    const afterRevoke = await apiCall(ctx, '/auth/refresh', {
      method: 'POST',
      body: { refreshToken: rotated },
    });
    assert.equal(afterRevoke.status, 401);
  });

  test('logout invalidates the access token', async () => {
    const user = await createUser(ctx);
    const before = await apiCall(ctx, '/auth/me', { token: user.token });
    assert.equal(before.status, 200);

    await apiCall(ctx, '/auth/logout', { method: 'POST', token: user.token });

    const after = await apiCall(ctx, '/auth/me', { token: user.token });
    assert.equal(after.status, 401);
  });

  test('revoking a session kills only that session', async () => {
    const user = await createUser(ctx);
    const second = await apiCall<{ accessToken: string }>(ctx, '/auth/login', {
      method: 'POST',
      body: { emailOrUsername: user.username, password: user.password },
    });
    const secondToken = second.body.data?.accessToken as string;

    const sessions = await apiCall<{ sessions: { id: string; current: boolean }[] }>(
      ctx,
      '/auth/sessions',
      { token: secondToken }
    );
    const other = sessions.body.data?.sessions.find((s) => !s.current);
    assert.ok(other, 'expected a second session to be listed');

    const revoked = await apiCall(ctx, `/auth/sessions/${other.id}`, {
      method: 'DELETE',
      token: secondToken,
    });
    assert.equal(revoked.status, 200);

    assert.equal((await apiCall(ctx, '/auth/me', { token: user.token })).status, 401);
    assert.equal((await apiCall(ctx, '/auth/me', { token: secondToken })).status, 200);
  });

  test('a user cannot revoke another user\'s session', async () => {
    const victim = await createUser(ctx);
    const attacker = await createUser(ctx);
    const sessions = await apiCall<{ sessions: { id: string }[] }>(ctx, '/auth/sessions', {
      token: victim.token,
    });
    const victimSession = sessions.body.data?.sessions[0];
    assert.ok(victimSession);

    const res = await apiCall(ctx, `/auth/sessions/${victimSession.id}`, {
      method: 'DELETE',
      token: attacker.token,
    });
    assert.equal(res.status, 404);
    // Victim's session must still work
    assert.equal((await apiCall(ctx, '/auth/me', { token: victim.token })).status, 200);
  });
});

describe('2FA challenge', () => {
  test('rejects an unknown challenge id', async () => {
    const res = await apiCall(ctx, '/auth/login/2fa', {
      method: 'POST',
      body: { challengeId: 'a'.repeat(48), code: '123456' },
    });
    assert.equal(res.status, 401);
  });

  test('validates the request body', async () => {
    const res = await apiCall(ctx, '/auth/login/2fa', {
      method: 'POST',
      body: { challengeId: '', code: '1' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error?.code, 'VALIDATION_ERROR');
  });
});
