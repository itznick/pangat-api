/**
 * Small in-memory failure limiter for brute-force protection (PIN logins, public tokens).
 * Process-local by design: it adds no infrastructure, and each instance still enforces the limit
 * (an attacker spreading over N instances gets N * max attempts, which is still bounded).
 */
export class AttemptLimiter {
  private readonly hits = new Map<string, { count: number; first: number; lockedUntil: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly lockMs: number,
    private readonly maxKeys = 5000,
  ) {}

  /** Seconds the caller must still wait, or 0 if the key may try. */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const e = this.hits.get(key);
    if (!e) return 0;
    if (e.lockedUntil > now) return Math.ceil((e.lockedUntil - now) / 1000);
    return 0;
  }

  fail(key: string, now = Date.now()): void {
    let e = this.hits.get(key);
    if (!e || now - e.first > this.windowMs) {
      e = { count: 0, first: now, lockedUntil: 0 };
    }
    e.count += 1;
    if (e.count >= this.maxFailures) e.lockedUntil = now + this.lockMs;
    this.hits.set(key, e);
    if (this.hits.size > this.maxKeys) this.prune(now);
  }

  succeed(key: string): void {
    this.hits.delete(key);
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) {
      if (v.lockedUntil < now && now - v.first > this.windowMs) this.hits.delete(k);
    }
    if (this.hits.size > this.maxKeys) {
      // still too large (sustained attack): drop oldest half
      const keys = [...this.hits.keys()].slice(0, Math.floor(this.hits.size / 2));
      keys.forEach((k) => this.hits.delete(k));
    }
  }
}
