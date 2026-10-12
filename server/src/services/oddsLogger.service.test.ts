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

import { logTodaysOdds, isValidTwoWay } from './oddsLogger.service';

/** Passe de 11 h ET le jour des matchs de test (mise au jeu 19 h ET). */
const GAME_DAY_11H_ET = new Date('2099-10-15T15:00:00Z');

const ev = (home: string, away: string, books: Record<string, [number, number]>,
            commence = '2099-10-15T23:00:00Z') => ({
  home_team: home, away_team: away, commence_time: commence,
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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(GAME_DAY_11H_ET);
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

describe('logTodaysOdds — avant-match, jour du match, prix plausibles (2026-10-12)', () => {
  it('un match déjà commencé ne touche ni odds_log ni odds_snapshots', async () => {
    // Passe de 21 h 45 ET : TOR–MTL a commencé à 19 h ET, prix « en direct ».
    vi.setSystemTime(new Date('2099-10-16T01:45:00Z'));
    events.value = [
      ev('Toronto Maple Leafs', 'Montreal Canadiens', { draftkings: [1.01, 23.0] }, '2099-10-15T23:00:00Z'),
      ev('Vancouver Canucks', 'Calgary Flames', { draftkings: [1.8, 2.05] }, '2099-10-16T02:00:00Z'),
    ];
    await logTodaysOdds('close');
    const [, logParams] = callsTo('INSERT INTO odds_log')[0];
    expect(logParams[1]).toEqual(['VAN']);
    const [, snapParams] = callsTo('INSERT INTO odds_snapshots')[0];
    expect(snapParams[1]).toEqual(['VAN']);
  });

  it("odds_log : seulement les matchs du jour ; les jours suivants vont en snapshot", async () => {
    events.value = [
      ev('Toronto Maple Leafs', 'Montreal Canadiens', { draftkings: [1.8, 2.05] }),
      ev('Boston Bruins', 'New York Rangers', { draftkings: [1.9, 1.95] }, '2099-11-20T00:00:00Z'),
    ];
    await logTodaysOdds('full');
    const [, logParams] = callsTo('INSERT INTO odds_log')[0];
    expect(logParams[1]).toEqual(['TOR']);
    const [, snapParams] = callsTo('INSERT INTO odds_snapshots')[0];
    expect([...snapParams[1]].sort()).toEqual(['BOS', 'TOR']);
  });

  it('aucun match du jour : rien dans odds_log, la série garde son point', async () => {
    events.value = [ev('Boston Bruins', 'New York Rangers', { draftkings: [1.9, 1.95] }, '2099-11-20T00:00:00Z')];
    expect(await logTodaysOdds('full')).toBe(0);
    expect(callsTo('INSERT INTO odds_log')).toHaveLength(0);
    expect(callsTo('INSERT INTO odds_snapshots')).toHaveLength(1);
  });

  it('une paire moneyline impossible (marge 0.87) est jetée, la puck line reste', async () => {
    events.value = [ev('Toronto Maple Leafs', 'Montreal Canadiens', { draftkings: [2.05, 2.65] })];
    await logTodaysOdds('full');
    const [, params] = callsTo('INSERT INTO odds_log')[0];
    expect(params[3]).toEqual([null]);           // home_ml
    expect(params[4]).toEqual([null]);           // away_ml
    expect(params[8]).toEqual([-1.5]);           // puck_line_home conservée
  });

  it('isValidTwoWay : bornes de marge', () => {
    expect(isValidTwoWay(1.8, 2.05)).toBe(true);    // 1.043
    expect(isValidTwoWay(2.05, 2.65)).toBe(false);  // 0.865 — trois issues
    expect(isValidTwoWay(1.5, 1.5)).toBe(false);    // 1.333 — absurde
    expect(isValidTwoWay(1.8, null)).toBe(false);
    expect(isValidTwoWay(1.0, 31)).toBe(false);     // une cote de 1.00 n'est pas un prix
  });
});
