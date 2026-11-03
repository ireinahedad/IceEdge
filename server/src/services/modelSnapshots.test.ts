import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Bilan public (X402_PLAN.md, phase 1). Ce qui compte :
 *   • TOUS les matchs de l'heure sont figés avant la mise au jeu, sans vote ;
 *   • le gel du matin est écrit UNE fois : un second passage rend les mêmes lignes ;
 *   • un match commencé n'est jamais figé ;
 *   • règlement seulement sur un match FINAL, idempotent (`outcome IS NULL`).
 * L'immuabilité d'une ligne réglée ou du matin est garantie par le déclencheur
 * de la migration 053 (vérifié contre un vrai Postgres, voir STATUS.md).
 */

const queries: Array<{ sql: string; params: unknown[] }> = [];
let handler: (sql: string, params: unknown[]) => any = () => ({ rows: [], rowCount: 0 });
vi.mock('../db/connection', () => ({
  pool: { query: async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return handler(sql, params); } },
}));

let games: Record<string, any> = {};
let schedule: any[] = [];
vi.mock('./nhlApiClient', () => ({
  fetchGameById: async (id: string) => { const g = games[id]; if (!g) throw new Error('down'); return g; },
  fetchGamesByDate: async () => schedule,
}));

let bundles: Record<string, any> = {};
let features: Record<string, any> = {};
vi.mock('./gameMlBundle', () => ({
  getGameMlBundle: async (id: string) => { const b = bundles[id]; if (!b) throw new Error('ml down'); return b; },
  getGameFeatures: async (id: string) => features[id] ?? {},
  mlBundleKey: (m: string, l: unknown, _s: unknown, home: boolean) => `${m}|${l ?? ''}|${home ? 'h' : 'a'}`,
}));

const NOW = Date.parse('2026-11-03T15:00:00Z');            // 10 h ET
const sched = (id: string, startInMin: number, over: Record<string, unknown> = {}) => ({
  id, status: 'scheduled', startTimeUTC: new Date(NOW + startInMin * 60_000).toISOString(),
  homeTeam: { abbreviation: 'TOR', score: null }, awayTeam: { abbreviation: 'MTL', score: null }, ...over,
});
const bundle = (home = 0.571234, hm = 0.27, am = 0.13) => ({
  live: undefined,
  byKey: {
    'moneyline||h':     { probability: 57, probability_exact: home, model_version: 'score-nhl-v1.0' },
    'puck_line|-1.5|h': { probability: 27, probability_exact: hm },
    'puck_line|-1.5|a': { probability: 13, probability_exact: am },
  },
});

const load = () => import('./modelSnapshots.service');
const inserts = () => queries.filter((q) => q.sql.includes('INSERT INTO model_snapshots'));

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  queries.length = 0;
  handler = () => ({ rows: [], rowCount: 0 });
  games = {}; schedule = []; bundles = {}; features = {};
});
afterEach(() => { vi.useRealTimers(); });

describe('logique pure', () => {
  it('preMatchProb : exact d\'abord, repli sur le %, rien en direct', async () => {
    const { preMatchProb } = await import('./modelSnapshots');
    expect(preMatchProb({ probability: 57, probability_exact: 0.5712 } as any)).toBe(0.5712);
    expect(preMatchProb({ probability: 57 } as any)).toBe(0.57);
    expect(preMatchProb({ probability: 57, probability_exact: 0.57, live: true } as any)).toBeNull();
    expect(preMatchProb({ probability: 0, probability_exact: 0 } as any)).toBeNull();
    expect(preMatchProb(null)).toBeNull();
  });

  it('snapshotProbs : rien sans victoire, ni sur un paquet en direct', async () => {
    const { snapshotProbs } = await import('./modelSnapshots');
    const key = (m: string, l: unknown, _s: unknown, h: boolean) => `${m}|${l ?? ''}|${h ? 'h' : 'a'}`;
    expect(snapshotProbs(bundle() as any, key)).toEqual({ homeWin: 0.57123, homeMinus: 0.27, awayMinus: 0.13, modelVersion: 'score-nhl-v1.0' });
    expect(snapshotProbs({ ...bundle(), live: { label: 'P2' } } as any, key)).toBeNull();
    expect(snapshotProbs({ byKey: { 'puck_line|-1.5|h': { probability: 27 } } } as any, key)).toBeNull();
    expect(snapshotProbs({ byKey: { 'moneyline||h': { probability: 60 } } } as any, key))
      .toEqual({ homeWin: 0.6, homeMinus: null, awayMinus: null, modelVersion: null });
  });

  it('morningExclusion et fenêtre d\'avant-match', async () => {
    const { morningExclusion, inPregameWindow, toScheduleGame } = await import('./modelSnapshots');
    const g = (min: number, status = 'scheduled') => toScheduleGame(sched('2026020187', min, { status }))!;
    expect(morningExclusion(g(300), NOW)).toBeNull();
    expect(morningExclusion(g(5), NOW)).toBe('starts_too_soon');
    expect(morningExclusion(g(-10), NOW)).toBe('started');
    expect(morningExclusion(g(300, 'live'), NOW)).toBe('started');
    expect(morningExclusion(g(300, 'ppd'), NOW)).toBe('not_scheduled');
    expect(inPregameWindow(g(45), NOW)).toBe(true);
    expect(inPregameWindow(g(90), NOW)).toBe(false);
    expect(inPregameWindow(g(-1), NOW)).toBe(false);
  });

  it('finalOutcome : final et non nul seulement', async () => {
    const { finalOutcome } = await import('./modelSnapshots');
    const fin = (h: number | null, a: number | null, status = 'final') =>
      ({ status, homeTeam: { score: h }, awayTeam: { score: a } });
    expect(finalOutcome(fin(4, 2))).toEqual({ homeScore: 4, awayScore: 2, outcome: 'home' });
    expect(finalOutcome(fin(2, 3))).toEqual({ homeScore: 2, awayScore: 3, outcome: 'away' });
    expect(finalOutcome(fin(2, 1, 'live'))).toBeNull();
    expect(finalOutcome(fin(null, null))).toBeNull();
  });
});

describe('snapshotPregame', () => {
  it('fige TOUS les matchs de l\'heure, sans vote, avec les gardiens saisis', async () => {
    schedule = [sched('2026020187', 30), sched('2026020188', 60), sched('2026020189', 180), sched('2026020190', -20, { status: 'live' })];
    bundles = { '2026020187': bundle(), '2026020188': bundle(0.4), '2026020189': bundle() };
    features = { '2026020187': { home_goalie: 'Woll', away_goalie: 'Montembeault' }, '2026020188': { home_goalie: 'Woll' } };
    const { snapshotPregame } = await load();
    expect(await snapshotPregame(NOW)).toBe(2);
    const ins = inserts();
    expect(ins.map((q) => q.params[0]).sort()).toEqual(['2026020187', '2026020188']);
    expect(ins.every((q) => q.params[1] === 'pregame')).toBe(true);
    expect(ins.every((q) => /DO UPDATE/.test(q.sql) && /outcome IS NULL/.test(q.sql) && /start_time > NOW\(\)/.test(q.sql))).toBe(true);
    const byId = Object.fromEntries(ins.map((q) => [q.params[0], q.params]));
    expect(byId['2026020187'][5]).toBe(0.57123);
    expect(byId['2026020187'][8]).toBe(true);        // deux gardiens saisis
    expect(byId['2026020188'][8]).toBe(false);       // un seul : titulaire supposé
    expect(queries.some((q) => /pickem_votes/.test(q.sql))).toBe(false);
  });

  it('ne fige rien si le match a commencé pendant le calcul, et ne lève jamais', async () => {
    schedule = [sched('2026020187', 30), sched('2026020188', 40)];
    bundles = { '2026020187': bundle() };           // 188 : service ML en panne
    const { snapshotPregame } = await load();
    vi.setSystemTime(NOW + 31 * 60_000);            // 187 commence pendant le calcul
    expect(await snapshotPregame(NOW)).toBe(0);
    expect(inserts()).toHaveLength(0);
  });

  it('aucune requête en base hors de la fenêtre', async () => {
    schedule = [sched('2026020187', 300)];
    const { snapshotPregame } = await load();
    expect(await snapshotPregame(NOW)).toBe(0);
    expect(queries).toHaveLength(0);
  });
});

describe('freezeMorning', () => {
  it('fige les matchs à venir une fois (DO NOTHING) et rend les lignes de la base', async () => {
    schedule = [sched('2026020187', 300), sched('2026020188', 5), sched('2026020189', -30, { status: 'live' })];
    bundles = { '2026020187': bundle() };
    const stored = {
      game_id: '2026020187', home_team: 'TOR', away_team: 'MTL', start_time: new Date(NOW + 300 * 60_000),
      home_win: '0.57123', home_minus: '0.27000', away_minus: null, goalies_confirmed: false,
      model_version: 'score-nhl-v1.0', recorded_at: new Date(NOW),
    };
    handler = (sql) => (/^\s*SELECT \*/.test(sql) ? { rows: [stored] } : { rows: [], rowCount: 1 });
    const { freezeMorning } = await load();
    const out = await freezeMorning('2026-11-03', NOW);
    const ins = inserts();
    expect(ins).toHaveLength(1);
    expect(ins[0].sql).toMatch(/ON CONFLICT \(game_id, kind\) DO NOTHING/);
    expect(ins[0].params[1]).toBe('morning');
    expect(out.games).toEqual([{
      gameId: '2026020187', home: 'TOR', away: 'MTL', startTimeUTC: stored.start_time.toISOString(),
      probabilities: { homeWin: 0.57123, homeMinus1_5: 0.27, awayMinus1_5: null },
      goaliesConfirmed: false, modelVersion: 'score-nhl-v1.0', recordedAt: new Date(NOW).toISOString(),
    }]);
    expect(out.excluded.map((e) => [e.gameId, e.reason]).sort()).toEqual([['2026020188', 'starts_too_soon'], ['2026020189', 'started']]);
  });

  it('second passage : aucun recalcul pour un match déjà figé', async () => {
    schedule = [sched('2026020187', 300)];
    bundles = {};                                    // un recalcul lèverait
    handler = (sql) => (/SELECT game_id FROM model_snapshots/.test(sql) ? { rows: [{ game_id: '2026020187' }] } : { rows: [] });
    const { freezeMorning } = await load();
    const out = await freezeMorning('2026-11-03', NOW);
    expect(inserts()).toHaveLength(0);
    expect(out.excluded).toEqual([]);
  });

  it('modèle indisponible : exclu avec la raison, pas d\'erreur', async () => {
    schedule = [sched('2026020187', 300)];
    const { freezeMorning } = await load();
    const out = await freezeMorning('2026-11-03', NOW);
    expect(out.excluded).toEqual([{ gameId: '2026020187', home: 'TOR', away: 'MTL', reason: 'model_unavailable' }]);
  });
});

describe('markMorningPublished', () => {
  it('refuse un commit mal formé, filtre les identifiants, ne marque que l\'à venir', async () => {
    const { markMorningPublished } = await load();
    await expect(markMorningPublished(['2026020187'], 'abc')).rejects.toMatchObject({ status: 400 });
    handler = () => ({ rows: [], rowCount: 1 });
    expect(await markMorningPublished(['2026020187', 'x; DROP', '2026020187'], 'a'.repeat(40))).toBe(1);
    expect(queries[0].params[0]).toEqual(['2026020187']);
    expect(queries[0].sql).toMatch(/proof_commit IS NULL AND outcome IS NULL AND start_time > NOW\(\)/);
  });
});

describe('settlePendingSnapshots', () => {
  it('règle les matchs finis seulement, idempotent', async () => {
    handler = (sql) => (/SELECT game_id/.test(sql)
      ? { rows: [{ game_id: '2026020187' }, { game_id: '2026020188' }, { game_id: '2026020189' }] }
      : { rows: [], rowCount: 2 });
    games = {
      '2026020187': { status: 'final', homeTeam: { score: 2 }, awayTeam: { score: 4 } },
      '2026020188': { status: 'live', homeTeam: { score: 1 }, awayTeam: { score: 0 } },
      // 189 : API muette → repris à la passe suivante
    };
    const { settlePendingSnapshots } = await load();
    expect(await settlePendingSnapshots(NOW)).toEqual({ games: 1, rows: 2 });
    const upd = queries.filter((q) => q.sql.includes('UPDATE model_snapshots'));
    expect(upd).toHaveLength(1);
    expect(upd[0].params).toEqual(['2026020187', 2, 4, 'away']);
    expect(upd[0].sql).toMatch(/outcome IS NULL/);
  });

  it('ne lève jamais (table absente)', async () => {
    handler = () => { throw new Error('relation "model_snapshots" does not exist'); };
    const { settlePendingSnapshots } = await load();
    expect(await settlePendingSnapshots(NOW)).toEqual({ games: 0, rows: 0 });
  });
});
