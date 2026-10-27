import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/** Câblage : connecté seulement ; 429 au quota ; Pro/admin illimités ; rien d'autre n'entre. */

let user: any = { sub: 'u1', email: 'a@b.com', role: 'user' };
vi.mock('../middleware/auth.middleware', () => ({
  authenticate: (req: any, res: any, next: any) => (user ? ((req.user = user), next()) : res.status(401).json({ error: 'no' })),
}));
let pro = false;
vi.mock('../services/subscription.service', () => ({ isPro: async () => pro }));

let verdict: any = { allowed: true, pro: false, used: 1, limit: 3, resetsAt: 'R' };
const calls: unknown[][] = [];
vi.mock('../services/scanQuota.service', () => ({
  consumeScan: async (...a: unknown[]) => { calls.push(['consume', ...a]); return verdict; },
  refundScan: async (...a: unknown[]) => { calls.push(['refund', ...a]); },
  getScanUsage: async (...a: unknown[]) => { calls.push(['usage', ...a]); return { pro: a[1], used: 0, limit: 3, remaining: 3, resetsAt: 'R' }; },
}));

async function app() {
  const { default: routes } = await import('./scan.routes');
  const a = express();
  a.use(express.json());
  a.use('/api/scan', routes);
  return a;
}

beforeEach(() => {
  user = { sub: 'u1', email: 'a@b.com', role: 'user' };
  pro = false;
  verdict = { allowed: true, pro: false, used: 1, limit: 3, resetsAt: 'R' };
  calls.length = 0;
});

describe('/api/scan', () => {
  it('déconnecté → 401, rien n’est décompté', async () => {
    user = null;
    expect((await request(await app()).post('/api/scan/start')).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('start : décompte un scan pour CE compte', async () => {
    const r = await request(await app()).post('/api/scan/start');
    expect(r.status).toBe(201);
    expect(calls).toEqual([['consume', 'u1', false]]);
  });

  it('quota épuisé → 429 scan_quota avec la remise à zéro', async () => {
    verdict = { allowed: false, reason: 'user', pro: false, used: 3, limit: 3, resetsAt: 'R' };
    const r = await request(await app()).post('/api/scan/start');
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: 'scan_quota', limit: 3, resetsAt: 'R' });
  });

  it('base injoignable → 503', async () => {
    verdict = { allowed: false, reason: 'db', pro: false, used: 0, limit: 3, resetsAt: 'R' };
    expect((await request(await app()).post('/api/scan/start')).status).toBe(503);
  });

  it('Pro et admin passent comme Pro', async () => {
    pro = true;
    await request(await app()).post('/api/scan/start');
    pro = false;
    user = { sub: 'a1', email: 'x@y.z', role: 'admin' };
    await request(await app()).post('/api/scan/start');
    expect(calls).toEqual([['consume', 'u1', true], ['consume', 'a1', true]]);
  });

  it('refund : rendu pour un compte gratuit, ignoré pour Pro', async () => {
    await request(await app()).post('/api/scan/refund');
    pro = true;
    await request(await app()).post('/api/scan/refund');
    expect(calls).toEqual([['refund', 'u1']]);
  });

  it('usage', async () => {
    const r = await request(await app()).get('/api/scan/usage');
    expect(r.body).toMatchObject({ limit: 3, remaining: 3 });
  });
});
