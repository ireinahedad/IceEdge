import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../services/auth.service', () => ({
  verifyAccessToken: (t: string) => { if (t === 'good') return { sub: 'u1', role: 'user' }; throw Object.assign(new Error('bad'), { status: 401 }); },
}));
vi.mock('../services/growth.service', () => ({ touchActivity: () => {} }));
vi.mock('../services/subscription.service', () => ({ isPro: async () => false }));

import { newsFeedKeyOrAccount } from './auth.middleware';

const app = () => express().get('/news', newsFeedKeyOrAccount, (_req, res) => { res.json({ ok: true }); });
const prev = process.env.NEWS_FEED_SECRET;
afterEach(() => { if (prev === undefined) delete process.env.NEWS_FEED_SECRET; else process.env.NEWS_FEED_SECRET = prev; });

describe('newsFeedKeyOrAccount', () => {
  it('bonne clé → passe sans compte', async () => {
    process.env.NEWS_FEED_SECRET = 's3cret';
    expect((await request(app()).get('/news').set('x-news-key', 's3cret')).status).toBe(200);
  });
  it('mauvaise clé → 401, même avec un jeton valide', async () => {
    process.env.NEWS_FEED_SECRET = 's3cret';
    const r = await request(app()).get('/news').set('x-news-key', 'nope').set('authorization', 'Bearer good');
    expect(r.status).toBe(401);
  });
  it('sans secret configuré, une clé ne suffit pas', async () => {
    delete process.env.NEWS_FEED_SECRET;
    expect((await request(app()).get('/news').set('x-news-key', 'anything')).status).toBe(401);
  });
  it('sans clé → compte exigé, comme avant', async () => {
    process.env.NEWS_FEED_SECRET = 's3cret';
    expect((await request(app()).get('/news')).status).toBe(401);
    expect((await request(app()).get('/news').set('authorization', 'Bearer good')).status).toBe(200);
  });
});
