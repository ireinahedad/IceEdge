import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import { Redis } from 'ioredis';
import { RedisRateLimitStore, RedisLimiterStore } from './rateLimitStore';

/**
 * Ligne D de AUDIT_SCALABILITE_COUTS.md — les compteurs de débit partagés.
 *
 * Ce qui est protégé ici n'a AUCUN symptôme visible à une instance : un
 * limiteur par process « marche » parfaitement tant qu'il n'y a qu'un process.
 * Le défaut n'apparaît qu'à la 2ᵉ instance (N instances = N × le quota), et le
 * repli n'apparaît qu'en panne Redis. D'où des tests qui fabriquent les deux.
 *
 * Les tests marqués « Redis réel » demandent `REDIS_TEST_URL` (ex.
 * `redis://127.0.0.1:6379/15` — base 15, vidée par les tests) et sont sautés
 * sans. Ceux du repli n'ont besoin d'aucun Redis : ils visent un port fermé.
 */

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;

/** Un client qui ne joindra jamais rien — la panne Redis, sans Redis. */
function deadClient(): Redis {
  const client = new Redis('redis://127.0.0.1:1', {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 250,
    retryStrategy: () => null,
    lazyConnect: true,
  });
  client.on('error', () => { /* attendu : c'est la panne qu'on simule */ });
  return client;
}

/** Une « instance » de l'application : un limiteur sur `/x`, son propre store. */
function appWith(store: RedisLimiterStore, limit: number, extra: Record<string, unknown> = {}) {
  const app = express();
  app.use(rateLimit({
    windowMs: 60_000, limit, store, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: () => 'client-1',
    ...extra,
  }));
  app.get('/x', (_req, res) => res.status(200).send('ok'));
  app.get('/fail', (_req, res) => res.status(401).send('non'));
  return app;
}

describe.skipIf(!REDIS_TEST_URL)('Redis réel', () => {
  let a: Redis;
  let b: Redis;

  beforeAll(() => {
    // Deux clients = deux conteneurs : rien n'est partagé entre eux sauf Redis.
    a = new Redis(REDIS_TEST_URL!, { maxRetriesPerRequest: 1 });
    b = new Redis(REDIS_TEST_URL!, { maxRetriesPerRequest: 1 });
  });
  afterAll(async () => { await a.quit(); await b.quit(); });
  beforeEach(async () => { await a.flushdb(); });

  describe('RedisRateLimitStore (chat, fenêtre glissante)', () => {
    it('refuse au-delà de max et n’enregistre pas le coup refusé', async () => {
      const store = new RedisRateLimitStore(() => a);
      const r = [];
      for (let i = 0; i < 5; i++) r.push(await store.tryConsume('msg:u1', 3, 10_000));
      expect(r).toEqual([true, true, true, false, false]);
      // Refusé ⇒ pas enregistré : la fenêtre ne s'allonge pas pendant qu'on throttle.
      expect(await a.zcard('rl:chat:msg:u1')).toBe(3);
    });

    it('rouvre quand les coups sortent de la fenêtre (glissante, pas fixe)', async () => {
      const store = new RedisRateLimitStore(() => a);
      expect(await store.tryConsume('k', 2, 300)).toBe(true);
      await new Promise((r) => setTimeout(r, 150));
      expect(await store.tryConsume('k', 2, 300)).toBe(true);
      expect(await store.tryConsume('k', 2, 300)).toBe(false);
      // Le 1er coup sort de la fenêtre à t≈300 ; le 2ᵉ y reste. Un seul slot rouvre.
      await new Promise((r) => setTimeout(r, 200));
      expect(await store.tryConsume('k', 2, 300)).toBe(true);
      expect(await store.tryConsume('k', 2, 300)).toBe(false);
    });

    it('LE TEST DE LA LIGNE D : deux instances partagent un seul quota', async () => {
      const instanceA = new RedisRateLimitStore(() => a);
      const instanceB = new RedisRateLimitStore(() => b);
      const r = [];
      for (let i = 0; i < 6; i++) r.push(await (i % 2 ? instanceB : instanceA).tryConsume('msg:u1', 4, 10_000));
      // En mémoire, chaque instance aurait accordé 4 : 8 au total, et ici 6/6.
      expect(r.filter(Boolean)).toHaveLength(4);
    });

    it('est atomique sous concurrence (pas de dépassement par course)', async () => {
      const s1 = new RedisRateLimitStore(() => a);
      const s2 = new RedisRateLimitStore(() => b);
      const r = await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? s1 : s2).tryConsume('burst', 10, 10_000)));
      expect(r.filter(Boolean)).toHaveLength(10);
    });

    it('pose une expiration : une clé inactive ne reste pas en mémoire Redis', async () => {
      await new RedisRateLimitStore(() => a).tryConsume('ttl', 5, 5_000);
      const ttl = await a.pttl('rl:chat:ttl');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(5_000);
    });
  });

  describe('RedisLimiterStore (express-rate-limit, fenêtre fixe)', () => {
    it('LE TEST DE LA LIGNE D : deux applications, un seul quota', async () => {
      const appA = appWith(new RedisLimiterStore(() => a, 'api'), 5);
      const appB = appWith(new RedisLimiterStore(() => b, 'api'), 5);
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) codes.push((await request(i % 2 ? appB : appA).get('/x')).status);
      expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
    });

    it('rend des en-têtes RateLimit cohérents avec le compteur partagé', async () => {
      const app = appWith(new RedisLimiterStore(() => a, 'api'), 5);
      await request(app).get('/x');
      const res = await request(app).get('/x');
      expect(res.headers['ratelimit']).toMatch(/limit=5, remaining=3, reset=(59|60)/);
    });

    it('sépare les limiteurs par préfixe (api et write ne se marchent pas dessus)', async () => {
      const api = appWith(new RedisLimiterStore(() => a, 'api'), 2);
      const write = appWith(new RedisLimiterStore(() => a, 'write'), 2);
      await request(api).get('/x'); await request(api).get('/x');
      expect((await request(api).get('/x')).status).toBe(429);
      expect((await request(write).get('/x')).status).toBe(200);
    });

    it('skipSuccessfulRequests (authLimiter) : seuls les échecs comptent, sur Redis aussi', async () => {
      const app = appWith(new RedisLimiterStore(() => a, 'auth'), 2, { skipSuccessfulRequests: true });
      for (let i = 0; i < 5; i++) expect((await request(app).get('/x')).status).toBe(200);
      expect(await a.get('rl:auth:client-1')).toBe('0');
      await request(app).get('/fail'); await request(app).get('/fail');
      expect((await request(app).get('/fail')).status).toBe(429);
    });

    it('decrement sur une clé expirée ne la recrée pas (pas de coup gratuit ensuite)', async () => {
      const store = new RedisLimiterStore(() => a, 'api');
      store.init({ windowMs: 60_000 } as any);
      await store.decrement('fantome');
      expect(await a.exists('rl:api:fantome')).toBe(0);
      store.shutdown();
    });
  });
});

describe('Repli quand Redis est injoignable (aucun Redis requis)', () => {
  it('chat : ni ouvert ni fermé — limité en mémoire locale', async () => {
    const dead = deadClient();
    const store = new RedisRateLimitStore(() => dead);
    const r = [];
    for (let i = 0; i < 4; i++) r.push(await store.tryConsume('msg:u1', 3, 10_000));
    expect(r).toEqual([true, true, true, false]);
    dead.disconnect();
  });

  it('express : le 429 tombe toujours au bon seuil, et vite', async () => {
    const dead = deadClient();
    const app = appWith(new RedisLimiterStore(() => dead, 'auth'), 3);
    const t0 = Date.now();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await request(app).get('/x')).status);
    expect(codes).toEqual([200, 200, 200, 429]);
    // Le limiteur est sur le chemin de chaque requête : une panne Redis ne doit
    // pas la faire attendre (client sans file hors-ligne, cf. redis.ts).
    expect(Date.now() - t0).toBeLessThan(2_000);
    dead.disconnect();
  });
});
