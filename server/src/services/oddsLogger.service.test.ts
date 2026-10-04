import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Collecte parallèle (2026-10-04) : DraftKings reste la série du CLV et
 * d'`odds_log` ; BET99 (livre parallèle) ne va que dans `odds_snapshots`, avec
 * son `bookmaker`. Vérifié aussi sur un vrai Postgres pendant le développement
 * (migrations 031 → 041) ; ce test garde la logique sous CI.
 */

const query = vi.fn();
vi.mock('../db/connection', () => ({ pool: { query: (...a: any[]) => query(...a) } }));
vi.mock('./oddsQuota', () => ({ collectorMaySpend: vi.fn(async () => true), remaining: vi.fn(() => 9999) }));

const events = { value: [] as any[] };
vi.mock('./oddsClient', () => ({
  ODDS_COLLECT_BOOKMAKERS: 'draftkings',
  ODDS_SHADOW_BOOKMAKERS: ['bet99_ca_on'],
  fetchCollectorOdds: vi.fn(async () => events.value),
}));

import { logTodaysOdds } from './oddsLogger.service';

const ev = (home: string, away: string, books: Record<string, [number, number]>) => ({
  home_team: home, away_team: away, commence_time: '2099-10-15T23:00:00Z',
  bookmakers: Object.entries(books).map(([key, [h, a]]) => ({
    key, markets: [
      { key: 'h2h', outcomes: [{ name: home, price: h }, { name: away, price: a }] },
      { key: 'spreads', outcomes: [{ name: home, price: 2.9, point: -1.5 }, { name: away, price: 1.45, point: 1.5 }] },
    ],
  })),
});

/** Paramètres de la requête dont le SQL contient `needle`. */
const callsTo = (needle: string) => query.mock.calls.filter(([sql]) => String(sql).includes(needle));

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 1 });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [{ key: 'icehockey_nhl', active: true }] })));
  process.env.ODDS_API_KEY = 'test';
  events.value = [
    // BET99 en PREMIER dans la réponse : le livre de collecte doit quand même gagner.
    ev('Toronto Maple Leafs', 'Montreal Canadiens', { bet99_ca_on: [1.83, 2.0], draftkings: [1.8, 2.05] }),
    // DraftKings absent : rien pour odds_log, BET99 seulement en snapshot.
    ev('Boston Bruins', 'New York Rangers', { bet99_ca_on: [1.9, 1.95] }),
  ];
});

describe('logTodaysOdds — collecte parallèle', () => {
  it('odds_log : livre de collecte SEUL, jamais un prix BET99', async () => {
    await logTodaysOdds('full');
    const [, params] = callsTo('INSERT INTO odds_log')[0];
    expect(params[1]).toEqual(['TOR']);          // BOS absent : DraftKings ne le cote pas
    expect(params[3]).toEqual([1.8]);            // prix DraftKings, pas 1.83
  });

  it('odds_snapshots : DraftKings ET BET99, chacun avec son livre, clé par livre', async () => {
    await logTodaysOdds('full');
    const [sql, params] = callsTo('INSERT INTO odds_snapshots')[0];
    expect(String(sql)).toContain("COALESCE(bookmaker, '')");
    const books: string[] = params[params.length - 1];
    const homes: string[] = params[1];
    const ml: number[] = params[6];
    const rows = homes.map((h, i) => `${h}|${books[i]}|${ml[i]}`).sort();
    expect(rows).toEqual(['BOS|bet99_ca_on|1.9', 'TOR|bet99_ca_on|1.83', 'TOR|draftkings|1.8']);
  });

  it('migration 041 absente : la série DraftKings est sauvée avec l\'ancienne clé', async () => {
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('INSERT INTO odds_snapshots') && String(sql).includes('COALESCE')) {
        throw Object.assign(new Error('no unique constraint'), { code: '42P10' });
      }
      return { rows: [], rowCount: 1 };
    });
    await logTodaysOdds('full');
    const legacy = callsTo('INSERT INTO odds_snapshots').filter(([sql]) => !String(sql).includes('COALESCE'));
    expect(legacy).toHaveLength(1);
    const params = legacy[0][1];
    expect(params[params.length - 1]).toEqual(['draftkings']);
    expect(params[1]).toEqual(['TOR']);
  });

  it('aucun match chez le livre de collecte : les livres parallèles gardent leur point', async () => {
    events.value = [ev('Boston Bruins', 'New York Rangers', { bet99_ca_on: [1.9, 1.95] })];
    expect(await logTodaysOdds('full')).toBe(0);
    expect(callsTo('INSERT INTO odds_log')).toHaveLength(0);
    const [, params] = callsTo('INSERT INTO odds_snapshots')[0];
    expect(params[params.length - 1]).toEqual(['bet99_ca_on']);
  });
});
