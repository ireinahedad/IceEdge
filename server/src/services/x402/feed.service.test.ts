import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Données de l'API pour agents. Ce qui compte :
 *   • liste blanche : aucun champ du paquet ML brut ne sort ;
 *   • un chiffre de repli (sans modèle de score) ou un match manquant fait
 *     échouer toute la journée en 503 — donc sans débit ;
 *   • avant-match seulement : les matchs commencés sortent dans `excluded` ;
 *   • bilan : précision, log-loss, Brier, calibration — aucune cote, aucun ROI.
 */

let schedule: any[] = [];
let scheduleDown = false;
vi.mock('../nhlApiClient', () => ({
  fetchGamesByDate: async () => { if (scheduleDown) throw new Error('down'); return schedule; },
  fetchGameById: async () => { throw new Error('unused'); },
}));

let bundles: Record<string, any> = {};
let features: Record<string, any> = {};
vi.mock('../gameMlBundle', () => ({
  getGameMlBundle: async (id: string) => { const b = bundles[id]; if (!b) throw new Error('ml down'); return b; },
  getGameFeatures: async (id: string) => features[id] ?? {},
  mlBundleKey: (m: string, l: unknown, _s: unknown, home: boolean) => `${m}|${l ?? ''}|${home ? 'h' : 'a'}`,
}));

let rows: any[] = [];
vi.mock('../../db/connection', () => ({ pool: { query: async () => ({ rows }) } }));

const NOW = Date.parse('2026-11-03T15:00:00Z');
const sched = (id: string, startInMin: number, status = 'scheduled') => ({
  id, status, startTimeUTC: new Date(NOW + startInMin * 60_000).toISOString(),
  homeTeam: { abbreviation: 'TOR' }, awayTeam: { abbreviation: 'MTL' },
});
const bundle = (over: Record<string, unknown> = {}) => ({
  generatedAt: new Date(NOW - 60_000).toISOString(),
  playerRates: { secret: { goals: 1 } },               // ne doit jamais sortir
  results: { 'ml-home': { probability: 57 } },
  byKey: {
    'moneyline||h':     { probability: 57, probability_exact: 0.571234, probability_score_model: 57, model_version: 'score-nhl-v1.0', explanation: 'interne' },
    'puck_line|-1.5|h': { probability: 27, probability_exact: 0.27312, probability_score_model: 57 },
    'puck_line|-1.5|a': { probability: 13, probability_exact: 0.13021, probability_score_model: 57 },
  },
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  schedule = []; scheduleDown = false; bundles = {}; features = {}; rows = [];
});
afterEach(() => vi.useRealTimers());

const load = async () => { const m = await import('./feed.service'); m.clearAgentCaches(); return m; };

describe('getAgentGames', () => {
  it('liste blanche, matchs commencés exclus, gardiens saisis', async () => {
    schedule = [sched('2026020187', 300), sched('2026020186', -30, 'live'), sched('2026020188', 400)];
    bundles = { '2026020187': bundle(), '2026020188': bundle() };
    features = { '2026020187': { home_goalie: 'Joseph Woll', away_goalie: 'Sam Montembeault', home_odds_decimal: 1.8 } };
    const { getAgentGames } = await load();
    const out = await getAgentGames('2026-11-03', NOW);
    expect(out.games.map((g) => g.gameId)).toEqual(['2026020187', '2026020188']);
    expect(out.games[0]).toEqual({
      gameId: '2026020187', home: 'TOR', away: 'MTL', startTimeUTC: new Date(NOW + 300 * 60_000).toISOString(),
      status: 'scheduled',
      probabilities: { homeWin: 0.5712, homeMinus1_5: 0.2731, awayMinus1_5: 0.1302 },
      goalies: { home: 'Joseph Woll', away: 'Sam Montembeault', confirmed: true },
      asOf: new Date(NOW - 60_000).toISOString(),
    });
    expect(out.games[1].goalies).toEqual({ home: null, away: null, confirmed: false });
    expect(out.excluded).toEqual([{ gameId: '2026020186', home: 'TOR', away: 'MTL', reason: 'started' }]);
    expect(out.modelVersion).toBe('score-nhl-v1.0');
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/secret|interne|odds_decimal|playerRates|byKey/);
    expect(Object.keys(out).sort()).toEqual(['asOf', 'date', 'disclaimer', 'excluded', 'games', 'modelVersion', 'notChecked', 'source']);
  });

  it('chiffre de repli (classifieur qui lit les cotes) : 503, rien n\'est vendu', async () => {
    schedule = [sched('2026020187', 300), sched('2026020188', 400)];
    const fallback = bundle();
    for (const k of Object.keys(fallback.byKey)) delete (fallback.byKey as any)[k].probability_score_model;
    bundles = { '2026020187': bundle(), '2026020188': fallback };
    const { getAgentGames } = await load();
    await expect(getAgentGames('2026-11-03', NOW)).rejects.toMatchObject({ status: 503, code: 'model_unavailable' });
  });

  it('un paquet ML en panne : 503 ; calendrier muet : 503 ; jour sans match à venir : 404', async () => {
    const { getAgentGames } = await load();
    schedule = [sched('2026020187', 300)];
    await expect(getAgentGames('2026-11-03', NOW)).rejects.toMatchObject({ status: 503, code: 'model_unavailable' });
    scheduleDown = true;
    await expect(getAgentGames('2026-11-03', NOW)).rejects.toMatchObject({ status: 503, code: 'schedule_unavailable' });
    scheduleDown = false;
    schedule = [sched('2026020186', -30, 'final')];
    await expect(getAgentGames('2026-11-03', NOW)).rejects.toMatchObject({ status: 404, code: 'no_games' });
  });

  it('paquet passé en direct : refusé', async () => {
    schedule = [sched('2026020187', 300)];
    bundles = { '2026020187': bundle({ live: { label: 'P1', final: false } }) };
    const { getAgentGames } = await load();
    await expect(getAgentGames('2026-11-03', NOW)).rejects.toMatchObject({ status: 503 });
  });
});

describe('getAgentResults', () => {
  it('précision, log-loss, Brier, calibration ; liens de preuve', async () => {
    const row = (id: string, p: number, hs: number, as: number) => ({
      game_id: id, home_team: 'TOR', away_team: 'MTL', start_time: new Date(NOW - 86_400_000), recorded_at: new Date(NOW - 90_000_000),
      home_win: String(p), home_minus: '0.30000', away_minus: null, home_score: hs, away_score: as, proof_commit: 'a'.repeat(40),
    });
    rows = [row('1', 0.7, 4, 1), row('2', 0.6, 1, 2), row('3', 0.3, 0, 3)];
    const { getAgentResults } = await load();
    const out = await getAgentResults('morning', 'owner/repo');
    expect(out.summary.games).toBe(3);
    expect(out.summary.homeWin.accuracy).toBeCloseTo(2 / 3, 4);
    const ll = -(Math.log(0.7) + Math.log(0.4) + Math.log(0.7)) / 3;
    expect(out.summary.homeWin.logLoss).toBeCloseTo(ll, 4);
    expect(out.summary.homeWin.brier).toBeCloseTo((0.09 + 0.36 + 0.09) / 3, 4);
    expect(out.summary.homeMinus1_5.n).toBe(3);                // 4-1 couvre, 1-2 et 0-3 non
    expect(out.summary.awayMinus1_5.n).toBe(0);
    expect(out.summary.calibrationHomeWin.map((b: any) => b.bin)).toEqual(['0.3-0.4', '0.6-0.7', '0.7-0.8']);
    expect(out.games[0].proof).toBe(`https://github.com/owner/repo/commit/${'a'.repeat(40)}`);
    expect(JSON.stringify(out)).not.toMatch(/odds_|\bROI\b|profit|stake|bookmaker/i);
  });
});
