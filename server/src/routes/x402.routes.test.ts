import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * API pour agents (X402_PLAN.md, phase 2) — le VRAI middleware @x402/express,
 * avec un facilitateur simulé. Ce qui compte :
 *   • sans paiement : 402 complète, et ni le ML ni la base ne sont touchés ;
 *   • AUCUN débit (settle) sur 4xx, 5xx, jour sans match, ML indisponible ;
 *   • un débit refusé (rejeu, fonds) ne livre pas la réponse ;
 *   • rien n'existe hors de l'hôte agents.
 * Le vrai paiement testnet reste à faire (STATUS.md §3.17).
 */

const calls = { games: 0, results: 0 };
let gamesImpl: (date: string) => Promise<any> = async () => ({ date: 'x', games: [] });
vi.mock('../services/x402/feed.service', () => ({
  etDate: () => '2026-11-03',
  getAgentGames: async (date: string) => { calls.games++; return gamesImpl(date); },
  getAgentResults: async () => { calls.results++; return { kind: 'morning', summary: { games: 0 }, games: [] }; },
}));

const PAY_TO = '0x51978CeE549f17039d4450784db846f2A7521C87';
const HOST = 'agents.arakice.com';

const fac = { verify: 0, settle: 0, verifyOk: true, settleOk: true, nonces: new Set<string>() };
const facilitator = {
  getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {} }),
  verify: async (p: any) => {
    fac.verify++;
    return fac.verifyOk ? { isValid: true, payer: p?.payload?.authorization?.from } : { isValid: false, invalidReason: 'invalid_signature' };
  },
  settle: async (p: any) => {
    fac.settle++;
    const nonce = p?.payload?.authorization?.nonce;
    if (!fac.settleOk || fac.nonces.has(nonce)) return { success: false, errorReason: 'nonce_already_used', transaction: '', network: 'eip155:84532' };
    fac.nonces.add(nonce);
    return { success: true, transaction: '0x' + 'ab'.repeat(32), network: 'eip155:84532', payer: p?.payload?.authorization?.from };
  },
};

async function makeApp() {
  const { loadX402Config } = await import('../services/x402/config');
  const { createAgentsRouter } = await import('./x402.routes');
  const cfg = loadX402Config({ X402_ENABLED: 'true', X402_PAY_TO: PAY_TO } as any)!;
  const app = express();
  app.use(createAgentsRouter(cfg, { facilitator: facilitator as any, syncFacilitatorOnStart: true }));
  app.use((_req, res) => res.status(418).json({ site: true }));        // « le reste de l'app »
  return app;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s: string) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));

async function requirements(app: express.Express) {
  const res = await request(app).get('/v1/nhl/games').set('Host', HOST);
  expect(res.status).toBe(402);
  return unb64(res.headers['payment-required']);
}

function paymentHeader(req: any, nonce = '0x' + '01'.repeat(32)) {
  return b64({
    x402Version: 2,
    resource: req.resource,
    accepted: req.accepts[0],
    payload: {
      signature: '0x' + '11'.repeat(65),
      authorization: {
        from: '0x' + '22'.repeat(20), to: PAY_TO, value: req.accepts[0].amount,
        validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce,
      },
    },
  });
}

beforeEach(() => {
  calls.games = 0; calls.results = 0;
  fac.verify = 0; fac.settle = 0; fac.verifyOk = true; fac.settleOk = true; fac.nonces.clear();
  gamesImpl = async (date) => ({ date, games: [{ gameId: '2026020187' }] });
});

describe('sans paiement', () => {
  it('402 complète, sans toucher au ML ni à la base', async () => {
    const app = await makeApp();
    const res = await request(app).get('/v1/nhl/games?date=2026-11-03').set('Host', HOST);
    expect(res.status).toBe(402);
    const pr = unb64(res.headers['payment-required']);
    expect(pr.x402Version).toBe(2);
    expect(pr.accepts[0]).toMatchObject({ scheme: 'exact', network: 'eip155:84532', payTo: PAY_TO, amount: '100000' });
    expect(pr.resource.url).toBe('https://agents.arakice.com/v1/nhl/games');
    expect(pr.extensions?.bazaar).toBeTruthy();
    expect(res.headers['access-control-expose-headers']).toMatch(/PAYMENT-REQUIRED/);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(calls.games).toBe(0);
    expect(fac.verify).toBe(0);
  });

  it('un paiement invalide : 402, handler jamais appelé', async () => {
    const app = await makeApp();
    const req = await requirements(app);
    fac.verifyOk = false;
    const res = await request(app).get('/v1/nhl/games').set('Host', HOST).set('PAYMENT-SIGNATURE', paymentHeader(req));
    expect(res.status).toBe(402);
    expect(calls.games).toBe(0);
    expect(fac.settle).toBe(0);
  });
});

describe('avec paiement', () => {
  it('200 : un seul débit, PAYMENT-RESPONSE posé, corps livré', async () => {
    const app = await makeApp();
    const req = await requirements(app);
    const res = await request(app).get('/v1/nhl/games').set('Host', HOST).set('PAYMENT-SIGNATURE', paymentHeader(req));
    expect(res.status).toBe(200);
    expect(res.body.games).toHaveLength(1);
    expect(fac.verify).toBe(1);
    expect(fac.settle).toBe(1);
    expect(unb64(res.headers['payment-response'])).toMatchObject({ success: true });
    expect(res.headers['cache-control']).toMatch(/private/);
  });

  it.each([
    ['ML indisponible (503)', async () => { throw Object.assign(new Error('Model temporarily unavailable'), { status: 503, code: 'model_unavailable' }); }, 503],
    ['jour sans match (404)', async () => { throw Object.assign(new Error('No upcoming NHL games'), { status: 404, code: 'no_games', excluded: [] }); }, 404],
    ['erreur interne (500)', async () => { throw new Error('boom'); }, 500],
  ])('%s : aucun débit', async (_label, impl, status) => {
    gamesImpl = impl as any;
    const app = await makeApp();
    const req = await requirements(app);
    const res = await request(app).get('/v1/nhl/games').set('Host', HOST).set('PAYMENT-SIGNATURE', paymentHeader(req));
    expect(res.status).toBe(status);
    expect(fac.verify).toBe(1);
    expect(fac.settle).toBe(0);
    expect(res.headers['payment-response']).toBeUndefined();
  });

  it('requête invalide (400) : aucun débit, handler de données jamais appelé', async () => {
    const app = await makeApp();
    const req = await requirements(app);
    for (const q of ['?date=2026-12-25', '?date=hier', '?foo=1']) {
      const res = await request(app).get(`/v1/nhl/games${q}`).set('Host', HOST).set('PAYMENT-SIGNATURE', paymentHeader(req));
      expect(res.status).toBe(400);
    }
    expect(fac.settle).toBe(0);
    expect(calls.games).toBe(0);
  });

  it('rejeu du même paiement : refusé, et la réponse n\'est pas livrée', async () => {
    const app = await makeApp();
    const req = await requirements(app);
    const header = paymentHeader(req);
    expect((await request(app).get('/v1/nhl/games').set('Host', HOST).set('PAYMENT-SIGNATURE', header)).status).toBe(200);
    const again = await request(app).get('/v1/nhl/games').set('Host', HOST).set('PAYMENT-SIGNATURE', header);
    expect(again.status).toBe(402);
    expect(again.body.games).toBeUndefined();
  });
});

describe('hôte et routes libres', () => {
  it('rien sur un autre hôte : la requête continue vers le reste de l\'app', async () => {
    const app = await makeApp();
    for (const path of ['/v1/nhl/games', '/v1/nhl/results', '/openapi.json', '/llms.txt']) {
      const res = await request(app).get(path).set('Host', 'api.arakice.com');
      expect(res.status).toBe(418);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(calls.games + calls.results).toBe(0);
  });

  it('sur l\'hôte agents, toute autre adresse rend 404 (le reste de l\'API n\'y est pas)', async () => {
    const app = await makeApp();
    expect((await request(app).get('/api/predict/summary').set('Host', HOST)).status).toBe(404);
  });

  it('bilan gratuit, découverte et preflight', async () => {
    const app = await makeApp();
    const r = await request(app).get('/v1/nhl/results').set('Host', HOST);
    expect(r.status).toBe(200);
    expect(calls.results).toBe(1);
    expect((await request(app).get('/v1/nhl/results?kind=x').set('Host', HOST)).status).toBe(400);

    const oa = await request(app).get('/openapi.json').set('Host', HOST);
    expect(oa.body.paths['/v1/nhl/games'].get['x-payment']).toMatchObject({ price: '$0.10', network: 'eip155:84532' });
    const wk = await request(app).get('/.well-known/x402').set('Host', HOST);
    expect(wk.body.resources[0].url).toBe('https://agents.arakice.com/v1/nhl/games');
    const llms = await request(app).get('/llms.txt').set('Host', HOST);
    expect(llms.text).toMatch(/Track record/);
    const pre = await request(app).options('/v1/nhl/games').set('Host', HOST);
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-headers']).toMatch(/PAYMENT-SIGNATURE/);
  });

  it('textes publics : ni « ICEEDGE », ni promesse de gain', async () => {
    const app = await makeApp();
    const texts = [
      JSON.stringify((await request(app).get('/openapi.json').set('Host', HOST)).body),
      JSON.stringify((await request(app).get('/.well-known/x402').set('Host', HOST)).body),
      (await request(app).get('/llms.txt').set('Host', HOST)).text,
      Buffer.from((await request(app).get('/v1/nhl/games').set('Host', HOST)).headers['payment-required'], 'base64').toString(),
    ].join('\n');
    expect(texts).not.toMatch(/iceedge/i);
    expect(texts).not.toMatch(/guarantee|profit|beat(s)? the market|\bROI\b|kelly|stake/i);
    const { GAMES_DESCRIPTION, RESULTS_DESCRIPTION } = await import('./x402.routes');
    expect(GAMES_DESCRIPTION.length).toBeLessThanOrEqual(500);
    expect(RESULTS_DESCRIPTION.length).toBeLessThanOrEqual(500);
  });
});

describe('configuration', () => {
  it('désactivée par défaut, refuse une adresse ou un réseau douteux', async () => {
    const { loadX402Config } = await import('../services/x402/config');
    expect(loadX402Config({} as any)).toBeNull();
    expect(() => loadX402Config({ X402_ENABLED: 'true', X402_PAY_TO: '0x123' } as any)).toThrow(/X402_PAY_TO/);
    expect(() => loadX402Config({ X402_ENABLED: 'true', X402_PAY_TO: PAY_TO, X402_NETWORK: 'eip155:8453' } as any)).toThrow(/MAINNET_GO/);
    expect(loadX402Config({ X402_ENABLED: 'true', X402_PAY_TO: PAY_TO, X402_NETWORK: 'eip155:8453', X402_MAINNET_GO: 'true' } as any)?.network).toBe('eip155:8453');
    expect(() => loadX402Config({ X402_ENABLED: 'true', X402_PAY_TO: PAY_TO, X402_ALLOW_ANY_HOST: 'true', NODE_ENV: 'production' } as any)).toThrow();
    expect(() => loadX402Config({ X402_ENABLED: 'true', X402_PAY_TO: PAY_TO, X402_PRICE_GAMES: '10' } as any)).toThrow(/PRICE/);
  });
});
