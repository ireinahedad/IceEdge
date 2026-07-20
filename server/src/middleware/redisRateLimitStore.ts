/**
 * redisRateLimitStore.ts
 *
 * Redis-backed RateLimitStore — a drop-in replacement for InMemoryRateLimitStore
 * that survives restarts and is shared across instances (multi-instance / HA).
 *
 * STATUS: stub, NOT wired in by default. To enable:
 *   1. npm i ioredis           (or the redis client of your choice)
 *   2. Create a client and pass it in, then swap the store in chat.routes.ts:
 *
 *        import Redis from 'ioredis';
 *        import { RedisRateLimitStore } from '../middleware/redisRateLimitStore';
 *        const redis = new Redis(process.env.REDIS_URL!);
 *        const rateStore: RateLimitStore = new RedisRateLimitStore(redis);
 *
 * No other change is required: the rate-limiting logic in chat.routes.ts only
 * depends on the RateLimitStore interface, not on the storage backend.
 *
 * To avoid adding a hard dependency before Redis is actually provisioned, this
 * file does NOT import a Redis library. It depends only on a minimal duck-typed
 * client interface (RedisEvalClient) that both `ioredis` and node-`redis` satisfy
 * for the `eval` call used below.
 */

import { RateLimitStore } from './rateLimitStore';

/**
 * Minimal subset of a Redis client this store needs. `ioredis`'s
 * `eval(script, numKeys, ...keysAndArgs)` matches this signature directly.
 */
export interface RedisEvalClient {
  eval(script: string, numKeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>;
}

/**
 * Atomic sliding-window log implemented as a single Lua script so the
 * read-decide-record sequence can't interleave between instances:
 *   - drop timestamps older than the window   (ZREMRANGEBYSCORE)
 *   - count what remains                        (ZCARD)
 *   - reject if already at the limit            (return 0, hit NOT recorded)
 *   - otherwise record the hit and set a TTL    (ZADD + PEXPIRE, return 1)
 *
 * Members are unique per hit ("<now>-<seq>") so concurrent hits in the same
 * millisecond don't collapse into one ZADD entry.
 */
const SLIDING_WINDOW_LUA = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max    = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= max then
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return 1
`;

export class RedisRateLimitStore implements RateLimitStore {
  private seq = 0;

  /**
   * @param client     A connected Redis client (e.g. `new Redis(REDIS_URL)`).
   * @param keyPrefix  Namespace so these keys don't collide with other Redis data.
   */
  constructor(
    private readonly client: RedisEvalClient,
    private readonly keyPrefix = 'rl:',
  ) {}

  async tryConsume(key: string, max: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    // Unique member per hit: same-ms hits must not dedupe into one ZSET entry.
    const member = `${now}-${this.seq++}`;
    const allowed = await this.client.eval(
      SLIDING_WINDOW_LUA,
      1,
      `${this.keyPrefix}${key}`,
      now,
      windowMs,
      max,
      member,
    );
    return allowed === 1;
  }
}
