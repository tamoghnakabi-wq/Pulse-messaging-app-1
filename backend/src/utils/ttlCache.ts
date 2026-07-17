/**
 * Tiny process-local TTL cache for hot auth/membership checks.
 * Not a substitute for Redis in multi-node deploys — documents single-node scale.
 */
export class TtlCache<V> {
  private store = new Map<string, { v: V; exp: number }>();
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;

  constructor(opts?: { maxSize?: number; ttlMs?: number }) {
    this.maxSize = opts?.maxSize ?? 20_000;
    this.defaultTtlMs = opts?.ttlMs ?? 15_000;
  }

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.v;
  }

  set(key: string, value: V, ttlMs = this.defaultTtlMs): void {
    if (this.store.size >= this.maxSize) {
      // Drop oldest ~1% to avoid O(n) full clear thrash
      let i = 0;
      const drop = Math.max(1, Math.floor(this.maxSize * 0.01));
      for (const k of this.store.keys()) {
        this.store.delete(k);
        if (++i >= drop) break;
      }
    }
    this.store.set(key, { v: value, exp: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

/** Shared membership cache: `${userId}:${conversationId}` → boolean */
export const membershipCache = new TtlCache<boolean>({ maxSize: 50_000, ttlMs: 20_000 });

/** Shared contact-list cache for presence fanout */
export const contactsCache = new TtlCache<string[]>({ maxSize: 10_000, ttlMs: 30_000 });
