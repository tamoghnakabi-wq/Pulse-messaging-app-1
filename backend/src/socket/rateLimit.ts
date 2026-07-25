/**
 * Simple per-socket token bucket for expensive realtime events.
 * Returns true when the event is allowed.
 *
 * Buckets are swept periodically: socket ids are never reused, so without a
 * sweep the map would grow by one entry per connection for the process lifetime.
 */
const SWEEP_INTERVAL_MS = 60_000;
/** A bucket older than this cannot affect any decision (window is 1s). */
const BUCKET_STALE_MS = 10_000;

type Bucket = { n: number; t: number };

const registry = new Set<Map<string, Bucket>>();
let sweeper: ReturnType<typeof setInterval> | null = null;

function sweep(): void {
  const cutoff = Date.now() - BUCKET_STALE_MS;
  for (const hits of registry) {
    for (const [id, row] of hits) {
      if (row.t < cutoff) hits.delete(id);
    }
  }
}

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);
  // Never hold the event loop open for a janitor
  sweeper.unref?.();
}

export function createSocketRateLimiter(maxPerSec: number) {
  const hits = new Map<string, Bucket>();
  registry.add(hits);
  ensureSweeper();
  return (socketId: string): boolean => {
    const now = Date.now();
    const row = hits.get(socketId);
    if (!row || now - row.t > 1000) {
      hits.set(socketId, { n: 1, t: now });
      return true;
    }
    if (row.n >= maxPerSec) return false;
    row.n += 1;
    return true;
  };
}

/** Test hook — stops the shared sweeper interval. */
export function stopRateLimitSweeper(): void {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}
