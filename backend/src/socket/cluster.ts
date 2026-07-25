/**
 * Optional multi-instance support.
 *
 * Without Redis, Pulse is single-instance by construction: room fan-out lives in
 * one process's memory, so a second replica silently drops messages, calls and
 * presence for anyone not connected to the same box.
 *
 * Setting REDIS_URL turns on two things:
 *   1. the Socket.IO Redis adapter, so `io.to(room).emit(...)`, `fetchSockets()`,
 *      `socketsJoin/Leave` and `disconnectSockets` reach every instance;
 *   2. a presence mirror, so `isUserOnline()` — which is synchronous and called
 *      on the send hot path — also sees users connected to other instances.
 *
 * The mirror is snapshot-based rather than event-based on purpose: each instance
 * republishes its full online set on a short interval under a TTL key, so a
 * crashed instance's users expire on their own and a newly started instance
 * converges without replaying an event log. Convergence is bounded by
 * PRESENCE_REFRESH_MS, comfortably inside the existing 25s offline grace.
 */
import type { Server } from 'socket.io';
import logger from '../utils/logger';

type RedisClient = {
  connect: () => Promise<unknown>;
  quit: () => Promise<unknown>;
  duplicate: () => RedisClient;
  on: (event: string, cb: (err: Error) => void) => unknown;
  set: (key: string, value: string, opts?: { EX?: number }) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
  scan: (
    cursor: number,
    opts: { MATCH: string; COUNT: number }
  ) => Promise<{ cursor: number; keys: string[] }>;
  mGet: (keys: string[]) => Promise<(string | null)[]>;
};

const PRESENCE_PREFIX = 'pulse:presence:';
const PRESENCE_REFRESH_MS = 5_000;
/** Must exceed refresh by enough that a slow tick never drops a live instance. */
const PRESENCE_TTL_SEC = 20;

let clustered = false;
let instanceId = '';
let pubClient: RedisClient | null = null;
let subClient: RedisClient | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let publishSnapshot: (() => Promise<void>) | null = null;
let nudgeTimer: ReturnType<typeof setTimeout> | null = null;

/** userIds online on *other* instances. Local sockets are tracked separately. */
const remoteOnline = new Set<string>();

export function isClustered(): boolean {
  return clustered;
}

/** True when another instance reports this user as connected. */
export function isRemoteOnline(userId: string): boolean {
  return remoteOnline.has(userId);
}

export function remoteOnlineIds(): string[] {
  return [...remoteOnline];
}

/**
 * Attach the Redis adapter when REDIS_URL is configured.
 * Returns false (and leaves the server fully functional in single-instance
 * mode) when Redis is absent or unreachable.
 */
export async function initCluster(
  io: Server,
  getLocalOnlineIds: () => string[]
): Promise<boolean> {
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    logger.info('Redis not configured — running single-instance (set REDIS_URL to scale out)');
    return false;
  }

  try {
    const { createClient } = (await import('redis')) as unknown as {
      createClient: (opts: { url: string }) => RedisClient;
    };
    const { createAdapter } = await import('@socket.io/redis-adapter');

    pubClient = createClient({ url });
    // Redis errors must never take the process down; log and keep serving.
    pubClient.on('error', (err) => logger.error('Redis pub client error', { message: err.message }));
    subClient = pubClient.duplicate();
    subClient.on('error', (err) => logger.error('Redis sub client error', { message: err.message }));

    await Promise.all([pubClient.connect(), subClient.connect()]);

    io.adapter(
      createAdapter(pubClient as never, subClient as never, { key: 'pulse' }) as never
    );

    instanceId =
      process.env.INSTANCE_ID?.trim() ||
      `${process.env.HOSTNAME || 'node'}-${process.pid}-${Date.now().toString(36)}`;
    clustered = true;

    publishSnapshot = async () => {
      try {
        const local = getLocalOnlineIds();
        await pubClient!.set(`${PRESENCE_PREFIX}${instanceId}`, JSON.stringify(local), {
          EX: PRESENCE_TTL_SEC,
        });
        await refreshRemoteOnline(local);
      } catch (err) {
        logger.warn('Presence snapshot failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };

    await publishSnapshot();
    refreshTimer = setInterval(() => void publishSnapshot?.(), PRESENCE_REFRESH_MS);
    refreshTimer.unref?.();

    logger.info(`Redis adapter enabled — clustered mode (instance ${instanceId})`);
    return true;
  } catch (err) {
    // Degrade to single instance rather than refusing to boot
    logger.error('Redis adapter setup failed — continuing single-instance', {
      message: err instanceof Error ? err.message : String(err),
    });
    clustered = false;
    return false;
  }
}

/** Rebuild the remote-online set from every live instance snapshot but our own. */
async function refreshRemoteOnline(localIds: string[]): Promise<void> {
  if (!pubClient) return;
  const keys: string[] = [];
  let cursor = 0;
  do {
    const res = await pubClient.scan(cursor, { MATCH: `${PRESENCE_PREFIX}*`, COUNT: 200 });
    cursor = Number(res.cursor);
    keys.push(...res.keys);
  } while (cursor !== 0);

  const ownKey = `${PRESENCE_PREFIX}${instanceId}`;
  const others = keys.filter((k) => k !== ownKey);
  if (!others.length) {
    remoteOnline.clear();
    return;
  }

  const values = await pubClient.mGet(others);
  const next = new Set<string>();
  for (const raw of values) {
    if (!raw) continue;
    try {
      for (const id of JSON.parse(raw) as string[]) next.add(id);
    } catch {
      /* skip a malformed snapshot rather than losing the whole refresh */
    }
  }
  // Locally-connected users are not "remote"; keeps the two sets disjoint.
  for (const id of localIds) next.delete(id);

  remoteOnline.clear();
  for (const id of next) remoteOnline.add(id);
}

/**
 * Republish this instance's presence set out of band.
 *
 * Called when a user's online state actually changes, so peers see it on their
 * next read instead of waiting for our own tick — halving worst-case presence
 * latency. Debounced so a reconnect storm cannot turn into a write storm.
 */
export function nudgeClusterPresence(): void {
  if (!clustered || !publishSnapshot || nudgeTimer) return;
  nudgeTimer = setTimeout(() => {
    nudgeTimer = null;
    void publishSnapshot?.();
  }, 250);
  nudgeTimer.unref?.();
}

/** Drop this instance's presence key so peers stop counting its users immediately. */
export async function shutdownCluster(): Promise<void> {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (nudgeTimer) {
    clearTimeout(nudgeTimer);
    nudgeTimer = null;
  }
  publishSnapshot = null;
  if (!clustered) return;
  try {
    await pubClient?.del(`${PRESENCE_PREFIX}${instanceId}`);
  } catch {
    /* best effort */
  }
  try {
    await Promise.all([pubClient?.quit(), subClient?.quit()]);
  } catch {
    /* best effort */
  }
  clustered = false;
  pubClient = null;
  subClient = null;
  remoteOnline.clear();
}
