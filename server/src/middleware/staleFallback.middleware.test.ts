import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { staleFallback, resetStaleFallback } from './staleFallback.middleware';

/**
 * Ces tests portent sur un comportement qui n'apparaît QUE pendant une panne
 * d'API tierce — donc jamais en développement, et jamais dans les autres tests.
 * Sans eux, un retrait du middleware passerait toute la suite au vert et ne se
 * verrait qu'à la prochaine coupure de l'API NHL, en production.
 */

/** Petite app dont on pilote la réponse à volonté. */
function app(handler: (req: express.Request, res: express.Response) => void) {
  const a = express();
  a.use(staleFallback);
  a.get('/data', handler);
  return a;
}

describe('staleFallback', () => {
  beforeEach(() => resetStaleFallback());

  it('sert la dernière réponse connue quand l’amont rend un 500', async () => {
    let healthy = true;
    const a = app((_req, res) => {
      if (healthy) res.json({ games: ['MTL-BOS'] });
      else res.status(500).json({ error: 'NHL API timeout' });
    });

    await request(a).get('/data').expect(200);

    healthy = false;
    const res = await request(a).get('/data');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ games: ['MTL-BOS'] });
    // Le client doit pouvoir signaler « données non à jour ». Sans en-tête, une
    // dégradation est indiscernable d'un fonctionnement normal — y compris pour
    // nous, dans les logs d'accès.
    expect(res.headers['x-stale-response']).toBe('1');
  });

  it('ne reconduit pas le périmé via le CDN', async () => {
    let healthy = true;
    const a = app((_req, res) => {
      if (healthy) res.json({ ok: true });
      else res.status(503).json({ error: 'down' });
    });

    await request(a).get('/data');
    healthy = false;
    const res = await request(a).get('/data');

    expect(res.headers['cache-control']).toBe('public, max-age=30');
    // `stale-while-revalidate` ferait resservir du périmé par-dessus du périmé.
    expect(res.headers['cache-control']).not.toMatch(/stale-while-revalidate/);
  });

  it('laisse passer les 4xx — un 404 est une réponse, pas une panne', async () => {
    let healthy = true;
    const a = app((_req, res) => {
      if (healthy) res.json({ id: 42 });
      else res.status(404).json({ error: 'Game not found' });
    });

    await request(a).get('/data').expect(200);

    healthy = false;
    const res = await request(a).get('/data');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Game not found' });
  });

  it('ne mémorise jamais une réponse d’erreur', async () => {
    const a = app((_req, res) => { res.status(500).json({ error: 'boom' }); });

    // Deux 500 d'affilée : le second ne doit pas « réussir » en resservant le
    // premier. Sinon le repli transformerait une panne franche en fausse
    // réponse 200.
    await request(a).get('/data').expect(500);
    const res = await request(a).get('/data');

    expect(res.status).toBe(500);
    expect(res.headers['x-stale-response']).toBeUndefined();
  });

  it('sépare les URL : une query différente est une entrée différente', async () => {
    let healthy = true;
    const a = express();
    a.use(staleFallback);
    a.get('/data', (req, res) => {
      if (healthy) res.json({ date: req.query.date });
      else res.status(500).json({ error: 'down' });
    });

    await request(a).get('/data?date=2026-01-01').expect(200);
    healthy = false;

    // Celle-ci a un périmé.
    const known = await request(a).get('/data?date=2026-01-01');
    expect(known.status).toBe(200);
    expect(known.body).toEqual({ date: '2026-01-01' });

    // Celle-là n'en a pas : elle doit échouer franchement, pas hériter de
    // la réponse d'une autre date.
    const unknown = await request(a).get('/data?date=2026-01-02');
    expect(unknown.status).toBe(500);
  });
});
