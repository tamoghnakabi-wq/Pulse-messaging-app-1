/**
 * Integration test harness.
 *
 * NOTE: keep suites as `test/<name>.test.ts`, flat in this directory. The npm
 * script globs `test/*.test.ts` so the *shell* expands it — Node only learned to
 * expand `**` patterns itself in v22, and CI (and package.json `engines`) run
 * Node 20, where a quoted `test/**\/*.test.ts` fails with "Could not find".
 * Helpers live in subdirectories precisely so they are not picked up as suites.
 *
 * Boots an ephemeral MongoDB (mongodb-memory-server) and the real Express app —
 * no mocks, no stubbed models — so tests exercise the same middleware chain,
 * validation and Mongo queries that production does.
 *
 * Environment must be set before `config` is imported (it reads process.env at
 * module load), so the app is pulled in via dynamic import after `startTestApp`.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import type { Express } from 'express';

export interface TestContext {
  baseUrl: string;
  /** Per-run upload root, so media tests can assert against the filesystem. */
  uploadDir: string;
  close: () => Promise<void>;
}

let uploadDir = '';

interface MemoryServer {
  getUri: () => string;
  stop: () => Promise<boolean>;
}

let memory: MemoryServer | null = null;
let server: http.Server | null = null;

export async function startTestApp(): Promise<TestContext> {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  memory = (await MongoMemoryServer.create({
    instance: { dbName: `pulse_test_${Date.now()}` },
  })) as unknown as MemoryServer;

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = memory.getUri();
  // Isolated upload root per run. Without this, config falls back to the repo's
  // real ./uploads directory and the suite writes test files into it.
  const os = await import('os');
  const fsMod = await import('fs');
  const pathMod = await import('path');
  uploadDir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'pulse-test-uploads-'));
  process.env.UPLOAD_DIR = uploadDir;
  process.env.JWT_ACCESS_SECRET = 'test_access_secret_at_least_32_characters_long';
  process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_at_least_32_characters_long';
  process.env.MEDIA_SIGNING_SECRET = 'test_media_secret_at_least_32_characters_long';
  process.env.CORS_ORIGINS = 'http://localhost:5173';
  process.env.LOG_LEVEL = 'error';
  // Keep limiter ceilings out of the way of tests that hammer endpoints
  process.env.RATE_LIMIT_MAX = '100000';
  process.env.AUTH_RATE_LIMIT_MAX = '100000';
  process.env.BCRYPT_ROUNDS = '10';

  const mongoose = (await import('mongoose')).default;
  await mongoose.connect(process.env.MONGODB_URI);
  // Model indexes (unique username/email, clientId idempotency) are what several
  // assertions depend on, and they are built lazily otherwise.
  const { User, Message, Conversation } = await import('../../src/models');
  await Promise.all([User.syncIndexes(), Message.syncIndexes(), Conversation.syncIndexes()]);

  const app = (await import('../../src/app')).default as Express;
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    uploadDir,
    close: async () => {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      await mongoose.disconnect();
      await memory?.stop();
      try {
        fsMod.rmSync(uploadDir, { recursive: true, force: true });
      } catch {
        /* temp dir cleanup is best effort */
      }
      server = null;
      memory = null;
    },
  };
}

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: {
    success?: boolean;
    data?: T;
    error?: { message?: string; code?: string };
  };
}

export async function apiCall<T = Record<string, unknown>>(
  ctx: TestContext,
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const res = await fetch(`${ctx.baseUrl}/api${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const body = (await res.json().catch(() => ({}))) as ApiResponse<T>['body'];
  return { status: res.status, body };
}

export interface TestUser {
  id: string;
  username: string;
  email: string;
  password: string;
  token: string;
  refreshToken: string;
}

let userSeq = 0;

/** Register a fresh user and return its credentials + tokens. */
export async function createUser(ctx: TestContext): Promise<TestUser> {
  userSeq += 1;
  const username = `tester${userSeq}${Date.now().toString(36).slice(-4)}`.toLowerCase();
  const email = `${username}@example.test`;
  const password = 'TestPassw0rd_x9';

  const res = await apiCall<{
    user: { id: string };
    accessToken: string;
    refreshToken: string;
  }>(ctx, '/auth/register', {
    method: 'POST',
    body: { username, email, password, displayName: username },
  });

  if (res.status !== 201 || !res.body.data) {
    throw new Error(`createUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    id: res.body.data.user.id,
    username,
    email,
    password,
    token: res.body.data.accessToken,
    refreshToken: res.body.data.refreshToken,
  };
}

/** Open (or fetch) the direct conversation between two users. */
export async function createDirectConversation(
  ctx: TestContext,
  from: TestUser,
  to: TestUser
): Promise<string> {
  const res = await apiCall<{ conversation: { id: string } }>(ctx, '/conversations/direct', {
    method: 'POST',
    token: from.token,
    body: { userId: to.id },
  });
  if (!res.body.data?.conversation?.id) {
    throw new Error(`createDirectConversation failed: ${JSON.stringify(res.body)}`);
  }
  return res.body.data.conversation.id;
}

export async function sendMessage(
  ctx: TestContext,
  user: TestUser,
  conversationId: string,
  content: string,
  extra: Record<string, unknown> = {}
): Promise<{ id: string; status: number }> {
  const res = await apiCall<{ message: { id: string } }>(
    ctx,
    `/messages/conversation/${conversationId}`,
    {
      method: 'POST',
      token: user.token,
      body: { content, clientId: `t-${Date.now()}-${Math.random().toString(36).slice(2)}`, ...extra },
    }
  );
  return { id: res.body.data?.message?.id || '', status: res.status };
}
