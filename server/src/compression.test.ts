import { describe, it, expect } from 'vitest';
import express from 'express';
import compression from 'compression';
import request from 'supertest';

// PERF_PLAN.md P1.4 — la configuration montée dans `app.ts` : le JSON au-dessus
// de 1 ko part compressé, l'ETag reste valable (304 du paquet ML).
function mini() {
  const a = express();
  a.use(compression({ threshold: 1024 }));
  const big = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ i, team: 'TOR', p: 0.5 })) });
  a.get('/big', (_req, res) => { res.set('ETag', '"v1"'); res.type('application/json').send(big); });
  a.get('/small', (_req, res) => { res.json({ ok: true }); });
  return a;
}

describe('compression des réponses', () => {
  it('compresse un gros JSON quand le client l’accepte', async () => {
    const res = await request(mini()).get('/big').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.rows).toHaveLength(500);   // supertest décompresse
  });

  it('laisse une petite réponse telle quelle', async () => {
    const res = await request(mini()).get('/small').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('répond toujours 304 sur un ETag connu', async () => {
    const res = await request(mini()).get('/big').set('Accept-Encoding', 'gzip').set('If-None-Match', '"v1"');
    expect(res.status).toBe(304);
  });
});
