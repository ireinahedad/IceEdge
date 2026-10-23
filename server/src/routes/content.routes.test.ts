import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/** Routes des combinés publiés : le secret garde les écritures, les lectures sont publiques. */

const freeze = vi.fn(async (date: string) => ({ date, created: true, parlays: [] }));
const forDate = vi.fn(async () => []);
vi.mock('../services/parlayLog.service', () => ({
  etToday: () => '2026-10-22',
  freezeDailyParlays: (d: string) => freeze(d),
  getParlaysForDate: () => forDate(),
  settlePendingParlays: async () => ({ checked: 0, settled: 0 }),
  getParlayRecord: async () => ({ since: null, won: 0, lost: 0, void: 0, pending: 0, winPct: null }),
  markParlaysPosted: async () => ({ updated: 2, alreadySet: false }),
}));

import contentRoutes from './content.routes';

const app = express().use(express.json()).use('/api/content', contentRoutes);
const OLD = process.env.CONTENT_CRON_SECRET;

beforeEach(() => { process.env.CONTENT_CRON_SECRET = 's3cret'; freeze.mockClear(); });
afterEach(() => { process.env.CONTENT_CRON_SECRET = OLD; });

describe('content routes', () => {
  it('écriture sans secret → 401, mauvais secret → 401', async () => {
    expect((await request(app).post('/api/content/parlays/freeze')).status).toBe(401);
    expect((await request(app).post('/api/content/parlays/freeze').set('X-Cron-Secret', 'nope')).status).toBe(401);
    expect(freeze).not.toHaveBeenCalled();
  });

  it('variable absente → 503 (rien d’ouvert par défaut)', async () => {
    delete process.env.CONTENT_CRON_SECRET;
    expect((await request(app).post('/api/content/parlays/freeze').set('X-Cron-Secret', 'x')).status).toBe(503);
  });

  it('bon secret → gel du jour ET par défaut (201)', async () => {
    const r = await request(app).post('/api/content/parlays/freeze').set('X-Cron-Secret', 's3cret');
    expect(r.status).toBe(201);
    expect(freeze).toHaveBeenCalledWith('2026-10-22');
  });

  it('date invalide → 400 ; lecture publique sans secret', async () => {
    expect((await request(app).post('/api/content/parlays/freeze').set('X-Cron-Secret', 's3cret').send({ date: '22/10' })).status).toBe(400);
    const r = await request(app).get('/api/content/parlays?date=2026-10-21');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ date: '2026-10-21', parlays: [] });
    expect((await request(app).get('/api/content/parlays/record')).status).toBe(200);
  });

  it('posted : kind inconnu → 400', async () => {
    const r = await request(app).post('/api/content/parlays/2026-10-22/posted').set('X-Cron-Secret', 's3cret').send({ kind: 'instagram' });
    expect(r.status).toBe(400);
  });
});
