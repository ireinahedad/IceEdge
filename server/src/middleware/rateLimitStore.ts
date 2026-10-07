/**
 * rateLimitStore.ts
 *
 * Storage abstraction for the per-user sliding-window rate limiter used by the
 * chat routes. The limiting *logic* (which action, how many, what window) lives
 * in the caller; this interface only owns *where* the hit counters are kept.
 *
 * The default implementation (InMemoryRateLimitStore) keeps counters in a
 * process-local Map. This is intended for SINGLE-INSTANCE deployments only:
 * counters are lost on restart and are not shared across instances.
 *
 * ── MULTI-INSTANCE (ligne D de AUDIT_SCALABILITE_COUTS.md, 2026-10-07) ──────
 *
 * Avec `REDIS_URL`, les compteurs vivent dans Redis et sont partagés entre
 * instances. Deux familles de limiteurs, deux stores :
 *
 *   - `RedisRateLimitStore` — le limiteur PAR ACTION du chat (`chat.routes.ts`),
 *     fenêtre GLISSANTE. Même sémantique exacte que la version mémoire : un
 *     ZSET d'horodatages par clé, évalué atomiquement par un script Lua.
 *   - `RedisLimiterStore` — le `store:` des huit limiteurs `express-rate-limit`
 *     (`rateLimit.middleware.ts`), fenêtre FIXE comme leur MemoryStore par
 *     défaut : INCR + PEXPIRE, atomiques dans un script Lua.
 *
 * Écrits ici plutôt qu'en ajoutant `rate-limit-redis` : ~60 lignes, aucune
 * dépendance de plus, et surtout le REPLI décrit ci-dessous, qu'aucun store
 * du commerce ne fait.
 *
 * ── QUAND REDIS TOMBE : NI OUVERT, NI FERMÉ — LOCAL ─────────────────────────
 *
 * Les deux réponses habituelles sont mauvaises. Laisser passer (« fail open »)
 * désarme `authLimiter` pendant la panne : c'est la fenêtre rêvée pour un
 * bourrage d'identifiants. Refuser (« fail closed ») transforme une panne du
 * CACHE en panne de toute l'API. Chaque store garde donc un compteur en mémoire
 * et y bascule sur toute erreur Redis — ce qui revient exactement au
 * comportement d'avant cette ligne : limité, mais par instance. La bascule et
 * le retour sont journalisés une fois chacun, pas à chaque requête.
 *
 * Sans `REDIS_URL`, les fabriques renvoient les stores mémoire : rien ne
 * change en local ni à une instance.
 */

import { randomUUID } from 'crypto';
import { MemoryStore } from 'express-rate-limit';
import type { Store, Options, ClientRateLimitInfo } from 'express-rate-limit';
import type { Redis } from 'ioredis';
import { redisCommandClient } from '../redis';
import { logger } from '../logger';

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

// ─── Redis ──────────────────────────────────────────────────────────────────

/** Préfixe commun : toutes les clés de débit se retrouvent sous `rl:*`. */
const KEY_PREFIX = 'rl:';

/**
 * Journalise la bascule vers la mémoire et le retour à Redis — une ligne par
 * transition, jamais une par requête : une panne Redis à 200 req/s ne doit
 * pas produire 200 lignes de log par seconde (la ligne V de l'audit facture
 * déjà le volume de logs).
 */
class DegradationLog {
  private degraded = false;
  constructor(private readonly store: string) {}
  failed(err: unknown): void {
    if (this.degraded) return;
    this.degraded = true;
    logger.warn(
      { store: this.store, err: err instanceof Error ? err.message : String(err) },
      '[rateLimit] Redis indisponible — compteurs en mémoire locale (limite PAR INSTANCE)',
    );
  }
  ok(): void {
    if (!this.degraded) return;
    this.degraded = false;
    logger.info({ store: this.store }, '[rateLimit] Redis rétabli — compteurs partagés');
  }
}

/**
 * Fenêtre glissante, atomique. Reproduit `InMemoryRateLimitStore.tryConsume` :
 * on oublie les horodatages hors fenêtre, on refuse SANS enregistrer si la
 * fenêtre est pleine, sinon on enregistre. L'heure vient de Redis (`TIME`) et
 * pas des conteneurs : deux instances dont les horloges divergent compteraient
 * sinon des fenêtres différentes pour la même clé.
 *
 * KEYS[1] = clé · ARGV[1] = max · ARGV[2] = fenêtre (ms) · ARGV[3] = membre unique
 */
const SLIDING_WINDOW_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then
  return 0
end
redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], window)
return 1
`;

export class RedisRateLimitStore implements RateLimitStore {
  private readonly prefix: string;
  private readonly fallback: RateLimitStore;
  private readonly log = new DegradationLog('chat');

  /**
   * @param client   Fournisseur du client — une fonction et pas une instance,
   *                 pour que les tests puissent couper Redis en cours de route.
   * @param fallback Le compteur de repli ; mémoire par défaut.
   */
  constructor(
    private readonly client: () => Redis | null,
    opts: { prefix?: string; fallback?: RateLimitStore } = {},
  ) {
    this.prefix = `${KEY_PREFIX}${opts.prefix ?? 'chat'}:`;
    this.fallback = opts.fallback ?? new InMemoryRateLimitStore();
  }

  async tryConsume(key: string, max: number, windowMs: number): Promise<boolean> {
    const redis = this.client();
    if (!redis) return this.fallback.tryConsume(key, max, windowMs);
    try {
      const allowed = await redis.eval(SLIDING_WINDOW_LUA, 1, this.prefix + key, max, windowMs, randomUUID());
      this.log.ok();
      return allowed === 1;
    } catch (err) {
      this.log.failed(err);
      return this.fallback.tryConsume(key, max, windowMs);
    }
  }
}

/**
 * Fenêtre fixe d'`express-rate-limit`, atomique : le premier coup d'une
 * fenêtre pose l'expiration, les suivants la lisent. Le `PTTL < 0` couvre aussi
 * une clé restée sans expiration (écriture interrompue) : elle en reçoit une
 * au lieu de bloquer son client pour toujours.
 *
 * KEYS[1] = clé · ARGV[1] = fenêtre (ms) → { coups, ms restantes }
 */
const FIXED_WINDOW_LUA = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }
`;

/** Ne décrémente qu'une clé encore vivante — sinon DECR recréerait une clé
 *  à -1, sans expiration, qui offrirait un coup gratuit à la fenêtre suivante. */
const DECREMENT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('DECR', KEYS[1])
end
return 0
`;

/**
 * Le `store:` d'un limiteur `express-rate-limit`. Une instance PAR limiteur :
 * la bibliothèque refuse qu'un store soit partagé (ERR_ERL_STORE_REUSE), et le
 * préfixe sépare les compteurs — `apiLimiter` et `writeLimiter` utilisent la
 * même clé client (`userOrIpKey`) et ne doivent pas se marcher dessus.
 */
export class RedisLimiterStore implements Store {
  /** Lu par express-rate-limit pour ses contrôles de double comptage. */
  readonly prefix: string;
  /** Les compteurs sont partagés : un coup compté ailleurs compte ici. */
  readonly localKeys = false;

  private windowMs = 60_000;
  private readonly fallback = new MemoryStore();
  private readonly log: DegradationLog;

  constructor(private readonly client: () => Redis | null, name: string) {
    this.prefix = `${KEY_PREFIX}${name}:`;
    this.log = new DegradationLog(name);
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const redis = this.client();
    if (!redis) return this.fallback.increment(key);
    try {
      const [hits, ttl] = (await redis.eval(FIXED_WINDOW_LUA, 1, this.prefix + key, this.windowMs)) as [number, number];
      this.log.ok();
      return { totalHits: Number(hits), resetTime: new Date(Date.now() + Number(ttl)) };
    } catch (err) {
      this.log.failed(err);
      return this.fallback.increment(key);
    }
  }

  async decrement(key: string): Promise<void> {
    const redis = this.client();
    if (!redis) return this.fallback.decrement(key);
    try {
      await redis.eval(DECREMENT_LUA, 1, this.prefix + key);
    } catch {
      // Un coup « rendu » perdu pendant une panne : le client reste compté une
      // fois de trop jusqu'à la fin de sa fenêtre. Le sens d'erreur sûr.
      await this.fallback.decrement(key);
    }
  }

  async resetKey(key: string): Promise<void> {
    await this.fallback.resetKey(key);
    const redis = this.client();
    if (!redis) return;
    try { await redis.del(this.prefix + key); } catch { /* repli déjà remis à zéro */ }
  }

  shutdown(): void {
    this.fallback.shutdown();
  }
}

// ─── Fabriques ──────────────────────────────────────────────────────────────

/** Le store du limiteur par action du chat : Redis si configuré, mémoire sinon. */
export function createChatRateLimitStore(): RateLimitStore {
  return redisCommandClient()
    ? new RedisRateLimitStore(redisCommandClient)
    : new InMemoryRateLimitStore();
}

/**
 * À étaler dans les options d'un limiteur : `rateLimit({ ...limiterStore('api'), … })`.
 * Sans Redis, ne renvoie RIEN — express-rate-limit garde alors son MemoryStore
 * par défaut, strictement comme avant.
 */
export function limiterStore(name: string): { store?: Store } {
  return redisCommandClient() ? { store: new RedisLimiterStore(redisCommandClient, name) } : {};
}

/** Pour la bannière de démarrage. */
export function rateLimitBackend(): 'redis' | 'memory' {
  return redisCommandClient() ? 'redis' : 'memory';
}
