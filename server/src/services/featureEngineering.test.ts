import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Ce que ce fichier prouve : construire les variables d'un match ne rappelle
 * PAS l'API NHL quand rien n'a changé.
 *
 * Le trou était dans la mise en cache des résultats NÉGATIFS.
 * `fetchTeamRestInfo` et `fetchTeamTravel` n'appelaient `setCached` que sur le
 * chemin qui trouve quelque chose ; le repli sortait par un `return` nu. Or le
 * cas vide n'est pas un cas d'erreur rare, c'est le cas NORMAL tant que la
 * saison n'a pas commencé — `played.length === 0` pour les 32 équipes. La
 * landing tire ~32 prédictions par chargement, donc autant d'appels
 * `club-schedule-season`, à chaque rechargement, indéfiniment.
 *
 * Mesuré ici sur une rafale de 8 matchs × 2 côtés, saison non commencée :
 *   avant  — 16 appels sortants, puis 16 DE PLUS au rechargement suivant
 *   après  — 16 appels sortants, puis 0
 *
 * Ce comportement n'a aucun symptôme fonctionnel : les probabilités sont
 * identiques avec ou sans. Rien d'autre ne le protège, d'où ce test — même
 * raisonnement que le garde-fou anti-troupeau de `nhlApiClient.test.ts`.
 */

vi.mock('./startingGoalies', () => ({ getStartingGoalies: vi.fn(async () => ({})) }));
vi.mock('./scratches',       () => ({
  getScratchesDay: vi.fn(async () => ({})),
  getLineupDay:    vi.fn(async () => ({ scratches: {}, dressed: {} })),
}));
vi.mock('./oddsClient',      () => ({
  fetchOddsImplied: vi.fn(async () => null),
  fetchTotalsOdds:  vi.fn(async () => null),
}));

/** Charge le module avec un `fetch` bouchonné qui compte les appels. */
async function load() {
  vi.resetModules();
  process.env.NHL_USE_MOCK = 'false';
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url));
    const m = /club-schedule-season\/([A-Z]{3})/.exec(String(url));
    const body: any = { data: [], standings: [] };
    // Saison PAS ENCORE COMMENCÉE : que des matchs à venir, aucun joué.
    body.games = m ? [{ gameType: 2, gameState: 'FUT', gameDate: '2099-10-08',
                        homeTeam: { abbrev: m[1] } }] : [];
    return { ok: true, status: 200, headers: new Headers(), json: async () => body } as any;
  });
  const mod = await import('./featureEngineering');
  return { ...mod, calls };
}

const PAIRS: [string, string][] = [
  ['EDM', 'CGY'], ['NYR', 'NYI'], ['COL', 'DAL'], ['VGK', 'LAK'],
  ['FLA', 'CAR'], ['NJD', 'PHI'], ['WPG', 'MIN'], ['SEA', 'VAN'],
];

describe('buildGameFeatures — appels sortants', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('un match déjà construit ne rappelle rien', async () => {
    const { buildGameFeatures, calls } = await load();
    await buildGameFeatures('TOR', 'MTL', 'moneyline');
    expect(calls.length).toBeGreaterThan(0);          // premier appel : à froid
    calls.length = 0;
    await buildGameFeatures('TOR', 'MTL', 'moneyline');
    expect(calls).toEqual([]);                        // deuxième : plus rien
  });

  it('une rafale type landing ne coûte rien au rechargement', async () => {
    const { buildGameFeatures, calls } = await load();
    const burst = () => Promise.all(PAIRS.flatMap(([h, a]) => [
      buildGameFeatures(h, a, 'moneyline'),
      buildGameFeatures(a, h, 'moneyline'),
    ]));
    await burst();
    const cold = calls.length;
    expect(cold).toBeGreaterThan(0);
    calls.length = 0;
    await burst();
    // C'EST le test. Avant la mise en cache des négatifs, ce rechargement
    // repayait exactement le même prix que le premier.
    expect(calls).toEqual([]);
  });

  it('le voyage n\'est pas calculé par défaut, et l\'est sur demande', async () => {
    const { buildGameFeatures, calls } = await load();
    await buildGameFeatures('TOR', 'MTL', 'moneyline');
    const f = await buildGameFeatures('BOS', 'TBL', 'moneyline');
    // Aucune valeur de voyage : le service Python n'en consomme aucune.
    expect(f.home_distance_km ?? 0).toBe(0);
    expect(f.away_tz_shift    ?? 0).toBe(0);

    calls.length = 0;
    const g = await buildGameFeatures('BOS', 'TBL', 'moneyline', undefined, { includeTravel: true });
    // Le calendrier est déjà en cache : activer le voyage ne coûte pas d'appel
    // supplémentaire, il lit la même réponse.
    expect(calls).toEqual([]);
    expect(g).toBeDefined();
  });
});

describe('buildGameFeatures — date du match (INCOHERENCES_ML §2)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('gardien partant et absents lus à la DATE DU MATCH, aujourd\'hui par défaut', async () => {
    const { buildGameFeatures } = await load();
    const goalies = (await import('./startingGoalies')).getStartingGoalies as any;
    const lineup  = (await import('./scratches')).getLineupDay as any;

    await buildGameFeatures('TOR', 'MTL', 'moneyline', undefined, { gameDate: '2099-10-09' });
    expect(goalies).toHaveBeenLastCalledWith('2099-10-09');
    expect(lineup).toHaveBeenLastCalledWith('2099-10-09');

    await buildGameFeatures('TOR', 'MTL', 'moneyline');
    expect(goalies).toHaveBeenLastCalledWith(undefined);   // → aujourd'hui (heure de l'Est)
    expect(lineup).toHaveBeenLastCalledWith(undefined);
  });

  it('le gardien saisi pour CE jour-là est envoyé', async () => {
    const { buildGameFeatures } = await load();
    const goalies = (await import('./startingGoalies')).getStartingGoalies as any;
    goalies.mockImplementation(async (d?: string) =>
      d === '2099-10-09' ? { TOR: 'Joseph Woll' } : { TOR: 'Anthony Stolarz' });
    const f = await buildGameFeatures('TOR', 'MTL', 'moneyline', undefined, { gameDate: '2099-10-09' });
    expect(f.home_goalie).toBe('Joseph Woll');
  });
});
