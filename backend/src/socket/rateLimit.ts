/**
 * Simple per-socket token bucket for expensive realtime events.
 * Returns true when the event is allowed.
 */
export function createSocketRateLimiter(maxPerSec: number) {
  const hits = new Map<string, { n: number; t: number }>();
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
