/**
 * Counts events per key inside a sliding time window. Process-local, like AttemptLimiter: it adds no infrastructure, and a
 * second instance simply enforces its own copy of the limit.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 5000,
  ) {}

  /** Records the event and returns true if it is within the limit; returns false (and does not record) when the limit is reached. */
  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.prune(now);
    return true;
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
}
