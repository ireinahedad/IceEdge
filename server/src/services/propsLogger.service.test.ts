import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Collecte des props joueur (2026-11-16). Trois comportements valent un test,
 * parce qu'ils coûtent des crédits ou de la donnée irrattrapable :
 *
 *   1. l'aplatissement d'une réponse par événement en lignes exploitables
 *      (plus / moins ET oui / non, deux formes dans les mêmes colonnes) ;
 *   2. le plafond quotidien, qui doit couper AVANT l'appel ;
 *   3. la rotation de l'ordre des matchs, sans quoi la troncature par budget
 *      biaiserait l'échantillon vers les mêmes matchs chaque soir.
 */

const query = vi.fn();
vi.mock('../db/connection', () => ({ pool: { query: (...a: any[]) => query(...a) } }));
vi.mock('./oddsQuota', () => ({
  collectorMaySpend: vi.fn(async () => true),
  observe: vi.fn(),
  remaining: vi.fn(() => 9999),
}));
vi.mock('./oddsClient', () => ({ collectorBookParam: () => 'draftkings' }));
vi.mock('../metrics', () => ({ recordUpstream: vi.fn() }));
vi.mock('./jobLock', () => ({
  withJobLock: async (_n: string, _t: number, fn: () => Promise<any>) =>
    ({ ran: true, result: await fn() }),
}));

import { collectProps, flattenEventProps, rotate, nextPropsSlot,
         __resetPropsBudgetForTests, propsBudgetState } from './propsLogger.service';

const EVENTS = [
  { id: 'e1', home_team: 'Toronto Maple Leafs', away_team: 'Montreal Canadiens',
    commence_time: '2099-10-15T23:00:00Z' },
  { id: 'e2', home_team: 'Boston Bruins', away_team: 'New York Rangers',
    commence_time: '2099-10-16T00:00:00Z' },
];

/** Réponse de l'endpoint par événement : un plus/moins et un oui/non. */
const eventOdds = () => ({
  commence_time: '2099-10-15T23:00:00Z',
  bookmakers: [{
    key: 'draftkings',
    markets: [
      { key: 'player_shots_on_goal', outcomes: [
        { name: 'Over',  description: 'Auston Matthews', price: 1.83, point: 3.5 },
        { name: 'Under', description: 'Auston Matthews', price: 1.95, point: 3.5 },
      ] },
      { key: 'player_goal_scorer_anytime', outcomes: [
        { name: 'Yes', description: 'William Nylander', price: 2.6 },
        { name: 'No',  description: 'William Nylander', price: 1.5 },
      ] },
    ],
  }],
});

function stubFetch(costHeader = '4') {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const body = url.includes('/events?') ? EVENTS : eventOdds();
    return {
      ok: true, status: 200,
      headers: { get: (h: string) => (h === 'x-requests-last' ? costHeader : null) },
      json: async () => body,
    };
  }));
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2099-10-15T15:25:00Z'));
  query.mockReset();
  query.mockResolvedValue({ rows: [{ t: 'props_snapshots' }], rowCount: 2 });
  process.env.ODDS_API_KEY = 'test';
  delete process.env.ODDS_PROPS_DAILY_BUDGET;
  __resetPropsBudgetForTests();
});

describe('flattenEventProps', () => {
  it('range plus/moins et oui/non dans les mêmes colonnes', () => {
    const rows = flattenEventProps(eventOdds(), '2099-10-15', 'TOR', 'MTL');
    const sog = rows.find((r) => r.market === 'player_shots_on_goal')!;
    expect(sog).toMatchObject({ player: 'Auston Matthews', line: 3.5, over: 1.83, under: 1.95 });
    // Marché oui/non : pas de seuil, « oui » dans over_price.
    const any = rows.find((r) => r.market === 'player_goal_scorer_anytime')!;
    expect(any).toMatchObject({ player: 'William Nylander', line: null, over: 2.6, under: 1.5 });
  });

  it('ignore un prop sans joueur — une ligne sans `description` est inexploitable', () => {
    const ev = { bookmakers: [{ key: 'draftkings', markets: [
      { key: 'player_points', outcomes: [{ name: 'Over', price: 1.9, point: 0.5 }] }] }] };
    expect(flattenEventProps(ev, '2099-10-15', 'TOR', 'MTL')).toHaveLength(0);
  });
});

describe('collectProps', () => {
  it('price chaque match et écrit les lignes', async () => {
    const calls = stubFetch();
    const written = await collectProps('open');
    // 1 recensement (gratuit) + 1 appel par match
    expect(calls.filter((u) => u.includes('/events?'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/events/'))).toHaveLength(2);
    expect(written).toBeGreaterThan(0);
    const [sql, params] = query.mock.calls.find(([s]) =>
      String(s).includes('INSERT INTO props_snapshots'))!;
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    // `observed_at` identique pour toute la passe : c'est ce qui permet de
    // regrouper « l'état du marché à 15 h 25 ».
    expect(new Set(params[3].map((d: Date) => d.toISOString())).size).toBe(1);
    expect(params[5].every((k: string) => k === 'open')).toBe(true);
  });

  // Le plafond est lu à l'import, comme `ODDS_EXTRAS_DAILY_BUDGET` côté
  // `oddsClient` : un changement sur Railway s'applique au redémarrage. Le test
  // doit donc recharger le module après avoir posé la variable.
  it('le plafond quotidien coupe AVANT de dépenser', async () => {
    process.env.ODDS_PROPS_DAILY_BUDGET = '4';   // de quoi payer un seul match
    vi.resetModules();
    const mod = await import('./propsLogger.service');
    mod.__resetPropsBudgetForTests();
    const calls = stubFetch('4');
    await mod.collectProps('open');
    expect(calls.filter((u) => u.includes('/events/'))).toHaveLength(1);
    expect(mod.propsBudgetState().spent).toBe(4);
    expect(mod.propsBudgetState().budget).toBe(4);
  });

  it('sans clé, aucun appel', async () => {
    delete process.env.ODDS_API_KEY;
    const calls = stubFetch();
    expect(await collectProps('open')).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('rotate', () => {
  it('décale l\'ordre avec le jour, sans perdre de match', () => {
    const a = rotate([1, 2, 3], new Date('2099-10-15T12:00:00Z'));
    const b = rotate([1, 2, 3], new Date('2099-10-16T12:00:00Z'));
    expect([...a].sort()).toEqual([1, 2, 3]);
    expect(a).not.toEqual(b);
  });
});

describe('nextPropsSlot', () => {
  it('vise le prochain créneau UTC, jamais dans le passé', () => {
    const { delayMs, kind } = nextPropsSlot(new Date('2099-10-15T15:30:00Z'));
    expect(delayMs).toBeGreaterThan(0);
    expect(kind).toBe('close');                 // 15:25 passé, reste 23:15
  });
});
