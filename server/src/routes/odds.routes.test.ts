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

const ODDS = '/api/odds/bet365/icehockey_nhl';
const EVENTS = [{ id: 'e1', home_team: 'A', away_team: 'B', bookmakers: [] }];

let upstreamCalls = 0;
let mode: 'ok' | 'fail' | 'slowfail' = 'ok';

async function app() {
  vi.resetModules();
  process.env.ODDS_API_KEY = 'test-key';
  const { default: routes } = await import('./odds.routes');
  const a = express();
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
