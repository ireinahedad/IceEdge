import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from './app';

// Smoke test the HTTP surface without a DB. /health is liveness-only so it must
// answer 200 even when Postgres is down; unknown routes 404 with a JSON body.
describe('app HTTP surface', () => {
  it('GET /health returns 200 {status:"ok"} (no DB dependency)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('unknown routes return a JSON 404', async () => {
    const res = await request(app).get('/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  it('rejects an invalid register payload with 400 (zod boundary)', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'nope', username: 'a', password: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});
