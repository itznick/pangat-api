/**
 * Tiny in-process cache with request coalescing: concurrent callers for the same key share one in-flight load, and a
 * result is reused for `ttlMs`. Used for hot, public, read-mostly endpoints (the diner QR menu).
 * `clear()` is called after every write so a cached value never outlives a change made through this API instance.
 */
export class TtlCache<T> {
  private readonly store = new Map<string, { at: number; value?: T; pending?: Promise<T> }>();
  private generation = 0;

  constructor(private readonly ttlMs: number, private readonly maxEntries = 500) {}

  async wrap(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.store.get(key);
    const now = Date.now();
    if (hit?.pending) return hit.pending;
    if (hit && hit.value !== undefined && now - hit.at < this.ttlMs) return hit.value;

    const gen = this.generation;
    const pending = load().then(
      (value) => {
        // a write happened while loading: hand the value to this caller but do not cache it
        if (gen === this.generation) {
          this.store.set(key, { at: Date.now(), value });
          this.evict();
        } else this.store.delete(key);
        return value;
      },
      (err) => {
        this.store.delete(key);
        throw err;
      },
    );
    this.store.set(key, { at: now, pending });
    return pending;
  }

  clear() {
    this.generation++;
    this.store.clear();
  }

  private evict() {
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }
}

/** Shared cache for GET /menu/public/:slug */
export const publicMenuCache = new TtlCache<unknown>(3000);
