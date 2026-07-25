/**
 * Media lifecycle: upload → persist → serve → replace → remove.
 *
 * Written after a live bug where a user's avatar and cover photo "disappeared
 * on every restart". The database was fine; the files were in a different
 * store (Docker volume vs local ./uploads). These tests pin the invariants
 * that make that class of failure detectable:
 *   - what the database stores is a relative path, not a host-specific URL
 *   - that path resolves to a real file under UPLOAD_DIR
 *   - the record survives a fresh read (what a restart actually looks like)
 *   - replacing media reclaims the old file and never the new one
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startTestApp, apiCall, createUser, type TestContext, type TestUser } from './helpers/harness';

let ctx: TestContext;
let user: TestUser;

before(async () => {
  ctx = await startTestApp();
  user = await createUser(ctx);
});

after(async () => {
  await ctx.close();
});

/** Smallest valid PNG (1x1). */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex'
);

async function uploadImage(
  endpoint: string,
  field: string,
  token: string,
  filename = 'pic.png'
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  form.append(field, new Blob([PNG], { type: 'image/png' }), filename);
  const res = await fetch(`${ctx.baseUrl}/api${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Resolve a stored `/uploads/...` path against the active UPLOAD_DIR. */
function onDisk(storedPath: string): string {
  const clean = storedPath.split('?')[0];
  return path.join(ctx.uploadDir, clean.replace(/^\/uploads\//, ''));
}

describe('avatar', () => {
  test('stores a relative path and writes the file under UPLOAD_DIR', async () => {
    const res = await uploadImage('/users/me/avatar', 'avatar', user.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const data = res.body.data as { avatar: string };
    // Signed for delivery, but what lands in the DB must stay relative
    assert.match(data.avatar, /^\/uploads\//, 'served avatar is not a relative path');

    const me = await apiCall<{ user: { avatar: string } }>(ctx, '/auth/me', { token: user.token });
    const stored = me.body.data?.user.avatar || '';
    assert.match(stored.split('?')[0], /^\/uploads\/images\//);
    assert.doesNotMatch(stored, /^https?:\/\//, 'stored an absolute host URL — will break on host change');
    assert.ok(fs.existsSync(onDisk(stored)), `file missing on disk: ${onDisk(stored)}`);
  });

  test('survives a fresh read of the record (the restart case)', async () => {
    const first = await apiCall<{ user: { avatar: string } }>(ctx, '/auth/me', { token: user.token });
    const before = (first.body.data?.user.avatar || '').split('?')[0];
    assert.ok(before);

    // A restart is just: same row, read again, file still where the path says
    const second = await apiCall<{ user: { avatar: string } }>(ctx, '/auth/me', { token: user.token });
    const after = (second.body.data?.user.avatar || '').split('?')[0];

    assert.equal(after, before, 'avatar path changed between reads');
    assert.ok(fs.existsSync(onDisk(after)), 'avatar file vanished between reads');
  });

  test('replacing reclaims the old file and keeps the new one', async () => {
    const before = await apiCall<{ user: { avatar: string } }>(ctx, '/auth/me', { token: user.token });
    const oldPath = (before.body.data?.user.avatar || '').split('?')[0];
    const oldFile = onDisk(oldPath);
    assert.ok(fs.existsSync(oldFile));

    const res = await uploadImage('/users/me/avatar', 'avatar', user.token, 'replacement.png');
    assert.equal(res.status, 200);

    const after = await apiCall<{ user: { avatar: string } }>(ctx, '/auth/me', { token: user.token });
    const newPath = (after.body.data?.user.avatar || '').split('?')[0];
    assert.notEqual(newPath, oldPath, 'avatar path did not change on replace');

    // The new file is what matters most — deleting it instead of the old one
    // would be the far worse bug.
    assert.ok(fs.existsSync(onDisk(newPath)), 'new avatar file missing');

    // Old file cleanup is asynchronous (fs.unlink callback); allow a tick
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(!fs.existsSync(oldFile), 'replaced avatar file was left orphaned on disk');
  });

  test('rejects a non-image upload', async () => {
    const form = new FormData();
    form.append('avatar', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'x.txt');
    const res = await fetch(`${ctx.baseUrl}/api/users/me/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.token}` },
      body: form,
    });
    assert.ok(res.status >= 400, `expected rejection, got ${res.status}`);
  });

  test('rejects an image whose bytes do not match its declared type', async () => {
    const form = new FormData();
    // Claims PNG, contains text — magic-byte check must catch it
    form.append('avatar', new Blob([Buffer.from('definitely not a png')], { type: 'image/png' }), 'fake.png');
    const res = await fetch(`${ctx.baseUrl}/api/users/me/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.token}` },
      body: form,
    });
    assert.ok(res.status >= 400, `content-type spoof accepted (${res.status})`);
  });
});

describe('cover photo', () => {
  test('uploads, persists and can be removed', async () => {
    const up = await uploadImage('/users/me/cover', 'cover', user.token, 'cover.png');
    assert.equal(up.status, 200, JSON.stringify(up.body));

    const me = await apiCall<{ user: { coverPhoto: string } }>(ctx, '/auth/me', { token: user.token });
    const stored = (me.body.data?.user.coverPhoto || '').split('?')[0];
    assert.match(stored, /^\/uploads\//);
    const file = onDisk(stored);
    assert.ok(fs.existsSync(file));

    const del = await apiCall(ctx, '/users/me/cover', { method: 'DELETE', token: user.token });
    assert.equal(del.status, 200);

    const after = await apiCall<{ user: { coverPhoto: string } }>(ctx, '/auth/me', { token: user.token });
    assert.equal(after.body.data?.user.coverPhoto || '', '', 'cover not cleared on the record');

    await new Promise((r) => setTimeout(r, 250));
    assert.ok(!fs.existsSync(file), 'removed cover left its file on disk');
  });
});

describe('media delivery is signature-gated', () => {
  let signedUrl = '';

  before(async () => {
    const res = await uploadImage('/users/me/avatar', 'avatar', user.token, 'served.png');
    signedUrl = (res.body.data as { avatar: string }).avatar;
  });

  test('serves a correctly signed URL', async () => {
    const res = await fetch(`${ctx.baseUrl}${signedUrl}`);
    assert.equal(res.status, 200);
    assert.ok(Number(res.headers.get('content-length')) > 0);
  });

  test('rejects the same path unsigned', async () => {
    const res = await fetch(`${ctx.baseUrl}${signedUrl.split('?')[0]}`);
    assert.equal(res.status, 401);
  });

  test('rejects a tampered signature', async () => {
    const url = new URL(`${ctx.baseUrl}${signedUrl}`);
    const sig = url.searchParams.get('sig') || '';
    url.searchParams.set('sig', `${sig.slice(0, -2)}xx`);
    const res = await fetch(url.toString());
    assert.equal(res.status, 401);
  });

  test('rejects an expired signature', async () => {
    const url = new URL(`${ctx.baseUrl}${signedUrl}`);
    url.searchParams.set('exp', String(Math.floor(Date.now() / 1000) - 60));
    const res = await fetch(url.toString());
    assert.equal(res.status, 401);
  });

  test('rejects path traversal out of the upload root', async () => {
    for (const attempt of [
      '/uploads/../../etc/passwd',
      '/uploads/images/../../../../etc/passwd',
      '/uploads/%2e%2e/%2e%2e/etc/passwd',
    ]) {
      const res = await fetch(`${ctx.baseUrl}${attempt}`);
      assert.ok(res.status >= 400, `traversal not blocked for ${attempt} (${res.status})`);
    }
  });
});

describe('integrity check', () => {
  test('reports referenced files that are absent from UPLOAD_DIR', async () => {
    const { checkMediaIntegrity } = await import('../src/utils/mediaIntegrity');

    const clean = await checkMediaIntegrity();
    assert.ok(clean.checked > 0, 'nothing was checked — the probe is not seeing media');
    assert.equal(clean.missing, 0, 'baseline should have every referenced file present');

    // Delete the bytes behind a live reference — exactly the Docker-volume case
    const me = await apiCall<{ user: { avatar: string } }>(ctx, '/auth/me', { token: user.token });
    const stored = (me.body.data?.user.avatar || '').split('?')[0];
    fs.rmSync(onDisk(stored));

    const broken = await checkMediaIntegrity();
    assert.ok(broken.missing >= 1, 'missing media went undetected');
  });
});
