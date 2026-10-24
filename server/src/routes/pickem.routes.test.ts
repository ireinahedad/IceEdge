import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/** Câblage : lecture publique, vote connecté, entrées validées avant le service. */

const USER = { sub: 'u1', email: 'a@b.com', role: 'user' };
let signedIn = true;
vi.mock('../middleware/auth.middleware', () => ({
  authenticate: (req: any, res: any, next: any) => (signedIn ? ((req.user = USER), next()) : res.status(401).json({ error: 'no' })),
  optionalAuthenticate: (req: any, _res: any, next: any) => { if (signedIn) req.user = USER; next(); },
}));

const calls: unknown[][] = [];
let fail: Error | null = null;
const answer = async () => { if (fail) throw fail; return { ok: true }; };
vi.mock('../services/pickem.service', () => ({
  getPickem: async (...a: unknown[]) => { calls.push(['get', ...a]); return answer(); },
  castPickem: async (...a: unknown[]) => { calls.push(['cast', ...a]); return answer(); },
  getPickemDay: async (...a: unknown[]) => { calls.push(['day', ...a]); return answer(); },
  getPickemLeaderboard: async (...a: unknown[]) => { calls.push(['board', ...a]); return answer(); },
}));

async function app() {
  const { default: routes } = await import('./pickem.routes');
  const a = express();
  a.use(express.json());
  a.use('/api/pickem', routes);
  return a;
}

describe('pickem.routes', () => {
  beforeEach(() => { calls.length = 0; signedIn = true; fail = null; });

  it('GET public, avec le vote de la personne connectée', async () => {
    const r = await request(await app()).get('/api/pickem/2026020123');
    expect(r.status).toBe(200);
    expect(calls).toEqual([['get', '2026020123', 'u1']]);
  });

  it('GET /today : jour entier, pas pris pour un identifiant de match', async () => {
    await request(await app()).get('/api/pickem/today').expect(200);
    signedIn = false;
    await request(await app()).get('/api/pickem/today').expect(200);
    expect(calls).toEqual([['day', 'u1'], ['day', undefined]]);
  });

  it('GET /leaderboard : semaine en cours par défaut, précédente sur demande, autre valeur refusée', async () => {
    const a = await app();
    await request(a).get('/api/pickem/leaderboard').expect(200);
    await request(a).get('/api/pickem/leaderboard?week=previous').expect(200);
    await request(a).get('/api/pickem/leaderboard?week=2026-10-19').expect(400);
    expect(calls).toEqual([['board', 0, 'u1'], ['board', -1, 'u1']]);
  });

  it('GET anonyme', async () => {
    signedIn = false;
    await request(await app()).get('/api/pickem/2026020123').expect(200);
    expect(calls).toEqual([['get', '2026020123', undefined]]);
  });

  it('POST exige la connexion', async () => {
    signedIn = false;
    await request(await app()).post('/api/pickem/2026020123').send({ team: 'VGK' }).expect(401);
    expect(calls).toEqual([]);
  });

  it('POST : équipe normalisée en majuscules', async () => {
    await request(await app()).post('/api/pickem/2026020123').send({ team: ' vgk ' }).expect(200);
    expect(calls).toEqual([['cast', 'u1', '2026020123', 'VGK']]);
  });

  it('entrées invalides : 400 sans appel au service', async () => {
    const a = await app();
    await request(a).get('/api/pickem/abc').expect(400);
    await request(a).post('/api/pickem/2026020123').send({ team: 'VEGAS!' }).expect(400);
    await request(a).post('/api/pickem/2026020123').send({}).expect(400);
    expect(calls).toEqual([]);
  });

  it('erreur du service : statut et code transmis', async () => {
    fail = Object.assign(new Error('Game already started'), { status: 409, code: 'GAME_STARTED' });
    const r = await request(await app()).post('/api/pickem/2026020123').send({ team: 'VGK' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('GAME_STARTED');
  });
});
