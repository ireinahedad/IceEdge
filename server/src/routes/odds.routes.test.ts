import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Proxy The Odds API (`/api/odds/*`) — combien d'appels AMONT pour N visiteurs ?
 *
 * `oddsClient.test.ts` couvre le client de pricing, pas cette route. Mesuré le
 * 2026-09-16 : amont en échec et aucune réponse périmée en mémoire (juste après
 * un redémarrage), 20 visiteurs successifs faisaient 20 appels amont, chacun
 * pouvant attendre `ODDS_FETCH_TIMEOUT_MS`. La déduplication en vol de
 * `TtlCache` ne couvre que les visiteurs simultanés, et `TtlCache` ne mémorise
 * pas un échec — d'où le cache d'échec de la route, que ces tests tiennent.
 */

vi.mock('../services/oddsQuota', () => ({ observe: vi.fn(), proxyTtlMs: (base: number) => base }));
// Le calendrier NHL de la route `/legs`, sans réseau.
vi.mock('../services/nhlApiClient', () => ({
  fetchGameById: vi.fn(async (id: string) => {
    if (id === '2026020001') return { status: 'scheduled', homeTeam: { abbreviation: 'MTL' }, awayTeam: { abbreviation: 'BOS' } };
    if (id === '2026020002') return { status: 'live', homeTeam: { abbreviation: 'MTL' }, awayTeam: { abbreviation: 'BOS' } };
    throw Object.assign(new Error('Game not found'), { status: 404 });
  }),
}));

const ODDS = '/api/odds/bet365/icehockey_nhl';
const EVENTS = [{ id: 'e1', home_team: 'A', away_team: 'B', bookmakers: [] }];

let upstreamCalls = 0;
let mode: 'ok' | 'fail' | 'slowfail' = 'ok';

async function app() {
  vi.resetModules();
  process.env.ODDS_API_KEY = 'test-key';
  // La route lit le cache de `oddsClient` (30 min par défaut) : on l'aligne sur
  // la fenêtre de 5 min que ces scénarios font expirer.
  process.env.ODDS_CACHE_TTL_MIN = '5';
  const { default: routes } = await import('./odds.routes');
  const a = express();
  a.use(express.json());
  a.use('/api/odds', routes);
  return a;
}

// Chaque test réimporte la route (`vi.resetModules`) : sur une machine chargée,
// cet import peut dépasser les 5 s par défaut — même marge que
// `IMPORT_HEAVY_TIMEOUT_MS` dans `httpCache.middleware.test.ts`.
describe('proxy des cotes — cache d’échec', { timeout: 20_000 }, () => {
  beforeEach(() => {
    upstreamCalls = 0;
    mode = 'ok';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
    vi.stubGlobal('fetch', vi.fn(async () => {
      upstreamCalls++;
      if (mode === 'slowfail') await new Promise((r) => setTimeout(r, 50));
      if (mode === 'ok') return new Response(JSON.stringify(EVENTS), { status: 200 });
      return new Response('{"message":"quota reached"}', { status: 401 });
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('amont en panne, rien de périmé : 20 visiteurs successifs → 1 seul appel amont', async () => {
    mode = 'fail';
    const a = await app();
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await request(a).get(ODDS)).status);

    expect(statuses.every((s) => s === 502)).toBe(true);
    expect(upstreamCalls).toBe(1);
  });

  it('visiteurs SIMULTANÉS sur un amont lent qui échoue → toujours dédoublonnés', async () => {
    mode = 'slowfail';
    const a = await app();
    await Promise.all(Array.from({ length: 20 }, () => request(a).get(ODDS)));
    expect(upstreamCalls).toBe(1);
  });

  it('pendant la fenêtre d’échec, sert le périmé sans rappeler l’amont', async () => {
    const a = await app();
    expect((await request(a).get(ODDS)).body).toEqual(EVENTS);   // amorce le cache
    expect(upstreamCalls).toBe(1);

    vi.setSystemTime(new Date('2026-09-16T12:06:00Z'));          // TTL de 5 min écoulé
    mode = 'fail';
    const first = await request(a).get(ODDS);                     // échec → périmé
    expect(first.status).toBe(200);
    expect(first.body).toEqual(EVENTS);
    expect(upstreamCalls).toBe(2);

    for (let i = 0; i < 10; i++) {
      const r = await request(a).get(ODDS);
      expect(r.body).toEqual(EVENTS);
    }
    expect(upstreamCalls).toBe(2);                                // aucun nouvel appel
  });

  it('retente après la fenêtre, et un succès efface la marque', async () => {
    mode = 'fail';
    const a = await app();
    await request(a).get(ODDS);
    expect(upstreamCalls).toBe(1);

    vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));           // 30 s : encore dans la fenêtre
    await request(a).get(ODDS);
    expect(upstreamCalls).toBe(1);

    vi.setSystemTime(new Date('2026-09-16T12:01:01Z'));           // 61 s : fenêtre passée
    mode = 'ok';
    const r = await request(a).get(ODDS);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(EVENTS);
    expect(upstreamCalls).toBe(2);
  });

  it('un échec sur une clé ne bloque pas une autre combinaison de marchés', async () => {
    mode = 'fail';
    const a = await app();
    await request(a).get(ODDS);
    mode = 'ok';
    const r = await request(a).get(`${ODDS}?markets=totals`);
    expect(r.status).toBe(200);
    expect(upstreamCalls).toBe(2);
  });

  it('/sports suit la même règle', async () => {
    mode = 'fail';
    const a = await app();
    for (let i = 0; i < 5; i++) await request(a).get('/api/odds/sports');
    expect(upstreamCalls).toBe(1);
  });
});

describe('proxy des cotes — appel amont partagé avec le moteur', { timeout: 20_000 }, () => {
  const FULL = [{
    id: 'e1', home_team: 'Montreal Canadiens', away_team: 'Boston Bruins',
    commence_time: '2026-10-08T23:00:00Z',
    bookmakers: [{
      key: 'betano_ca_on', title: 'Betano',
      markets: [
        { key: 'h2h', outcomes: [{ name: 'Montreal Canadiens', price: 2.1 },
                                 { name: 'Boston Bruins', price: 1.8 }] },
        { key: 'spreads', outcomes: [{ name: 'Montreal Canadiens', price: 1.4, point: 1.5 },
                                     { name: 'Boston Bruins', price: 2.9, point: -1.5 }] },
        { key: 'totals', outcomes: [{ name: 'Over', price: 1.9, point: 6.5 },
                                    { name: 'Under', price: 1.9, point: 6.5 }] },
      ],
    }],
  }];

  beforeEach(() => {
    upstreamCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      upstreamCalls++;
      return new Response(JSON.stringify(FULL), { status: 200 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('route (deux jeux de marchés) + moteur de paris → UN seul appel amont', async () => {
    const a = await app();
    await request(a).get(ODDS);                       // h2h
    await request(a).get(`${ODDS}?markets=h2h,spreads,totals`);
    const { fetchOddsImplied } = await import('../services/oddsClient');
    expect(await fetchOddsImplied('Montreal Canadiens', 'Boston Bruins')).not.toBeNull();
    expect(upstreamCalls).toBe(1);
  });

  it('ne renvoie que les marchés demandés', async () => {
    const a = await app();
    const r = await request(a).get(`${ODDS}?markets=h2h`);
    expect(r.body[0].bookmakers[0].markets.map((m: any) => m.key)).toEqual(['h2h']);
    expect(r.body[0].bookmakers[0].title).toBe('Betano');
  });

  it('un autre sport ne déclenche aucun appel facturé', async () => {
    const a = await app();
    const r = await request(a).get('/api/odds/bet365/basketball_nba');
    expect(r.body).toEqual([]);
    expect(upstreamCalls).toBe(0);
  });
});

describe('POST /api/odds/legs — prix des jambes de coupon', { timeout: 20_000 }, () => {
  const FULL = [{
    id: 'e1', home_team: 'Montreal Canadiens', away_team: 'Boston Bruins',
    commence_time: '2026-10-08T23:00:00Z',
    bookmakers: [{ key: 'betano_ca_on', title: 'Betano (Ontario)', markets: [
      { key: 'h2h', outcomes: [{ name: 'Montreal Canadiens', price: 2.1 }, { name: 'Boston Bruins', price: 1.8 }] },
    ] }],
  }];
  beforeEach(() => {
    upstreamCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { upstreamCalls++; return new Response(JSON.stringify(FULL), { status: 200 }); }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('rend le prix des jambes cotées, ignore les autres, en UN appel amont', async () => {
    const a = await app();
    const r = await request(a).post('/api/odds/legs').send({ legs: [
      { id: 'l1', gameId: '2026020001', marketType: 'moneyline', selectionValue: 'mtl' },
      { id: 'l2', gameId: '2026020001', marketType: 'moneyline', selectionValue: 'bos' },
      { id: 'l3', gameId: '2026020001', marketType: 'total_goals', selectionValue: 'over', line: 6.5 },
      { id: 'l4', gameId: '2026020002', marketType: 'moneyline', selectionValue: 'mtl' },   // match commencé
      { id: 'l5', gameId: '2026029999', marketType: 'moneyline', selectionValue: 'mtl' },   // inconnu
    ] });
    expect(r.status).toBe(200);
    expect(r.body.prices).toEqual({
      l1: { price: 2.1, bookTitle: 'Betano (Ontario)' },
      l2: { price: 1.8, bookTitle: 'Betano (Ontario)' },
    });
    expect(upstreamCalls).toBe(1);
  });

  it('refuse un corps hors schéma (400), sans appel amont', async () => {
    const a = await app();
    expect((await request(a).post('/api/odds/legs').send({ legs: [{ id: 'x', gameId: 'abc', marketType: 'moneyline', selectionValue: 'mtl' }] })).status).toBe(400);
    expect((await request(a).post('/api/odds/legs').send({ legs: Array.from({ length: 21 }, (_, i) => ({ id: `l${i}`, gameId: '2026020001', marketType: 'moneyline', selectionValue: 'mtl' })) })).status).toBe(400);
    expect((await request(a).post('/api/odds/legs').send({ legs: [{ id: 'x', gameId: '2026020001', marketType: 'anytime_goal', selectionValue: 'yes' }] })).status).toBe(400);
    expect(upstreamCalls).toBe(0);
  });
});
