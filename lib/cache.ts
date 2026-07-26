/**
 * Caching primitives.
 *
 * Cost control is the whole point of this product, so caching is deliberately layered:
 *
 *  1. `TtlCache` — per-process memory. Free, instant, lost on dyno restart.
 *  2. Postgres (`lib/scoreStore.ts`) — shared across dynos, survives restarts.
 *  3. The precomputed grid — populated offline for metros we care about.
 *
 * A request should only ever reach Overpass when all three miss.
 */

export class TtlCache<V> {
  private map = new Map<string, { value: V; expires: number }>();

  constructor(
    private maxEntries = 1000,
    private ttlMs = 5 * 60 * 1000
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency for the LRU eviction below.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs?: number): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { value, expires: Date.now() + (ttlMs ?? this.ttlMs) });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Deduplicate concurrent identical work.
 *
 * Without this, ten property pages loading the same neighbourhood at once fire ten
 * Overpass queries. With it they share one.
 */
export class SingleFlight<V> {
  private inFlight = new Map<string, Promise<V>>();

  run(key: string, fn: () => Promise<V>): Promise<V> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = fn().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  get pending(): number {
    return this.inFlight.size;
  }
}
