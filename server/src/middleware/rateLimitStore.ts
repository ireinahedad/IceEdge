/**
 * rateLimitStore.ts
 *
 * Storage abstraction for the per-user sliding-window rate limiter used by the
 * chat routes. The limiting *logic* (which action, how many, what window) lives
 * in the caller; this interface only owns *where* the hit counters are kept.
 *
 * The default implementation (InMemoryRateLimitStore) keeps counters in a
 * process-local Map. This is intended for SINGLE-INSTANCE deployments only:
 * counters are lost on restart and are not shared across instances. To support
 * multi-instance / restart-persistent limiting, implement RateLimitStore with a
 * shared backend (e.g. Redis using INCR + PEXPIRE) and swap the instance passed
 * to the middleware — no changes to the rate-limiting logic are required.
 */

export interface RateLimitStore {
  /**
   * Atomically evaluate the sliding window for `key` and record the hit when
   * allowed. Returns true if the request is within `max` hits over `windowMs`,
   * false if it should be rejected (429). A rejected request is NOT recorded,
   * so the window does not extend while the caller is being throttled.
   *
   * Returns a Promise so async backends (Redis) can implement it without
   * changing callers; the in-memory implementation resolves synchronously.
   */
  tryConsume(key: string, max: number, windowMs: number): Promise<boolean>;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, number[]>();
  private readonly maxWindowMs: number;

  /**
   * @param opts.maxWindowMs      Longest window any caller uses; timestamps
   *                              older than this are pruned. Default 10 min.
   * @param opts.pruneIntervalMs  How often the background prune runs.
   */
  constructor(opts: { maxWindowMs?: number; pruneIntervalMs?: number } = {}) {
    this.maxWindowMs = opts.maxWindowMs ?? 10 * 60_000;
    const interval = setInterval(() => this.prune(), opts.pruneIntervalMs ?? 10 * 60_000);
    // Don't keep the event loop alive just for pruning.
    interval.unref();
  }

  async tryConsume(key: string, max: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const hits = (this.buckets.get(key) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      // Persist the pruned window so it keeps shrinking, but don't record the hit.
      this.buckets.set(key, hits);
      return false;
    }
    hits.push(now);
    this.buckets.set(key, hits);
    return true;
  }

  /** Drop timestamps (and empty buckets) older than the longest window. */
  private prune(): void {
    const now = Date.now();
    for (const [key, hits] of this.buckets) {
      const alive = hits.filter((t) => now - t < this.maxWindowMs);
      if (alive.length === 0) this.buckets.delete(key);
      else this.buckets.set(key, alive);
    }
  }
}
