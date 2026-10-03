import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * « Best bets » — chiffrés par le paquet ML du match (ml/INCOHERENCES_ML.md §11).
 *
 * Avant : seuls les `mlDepth` premiers candidats SELON LES RÈGLES recevaient un
 * score ML, et les paris joueur passaient par `/predict/player` (Poisson de
 * saison) au lieu du modèle joueur de la page du match.
 */

const GAME = {
  id: 'g1', status: 'scheduled', gameDate: '2099-10-08', startTime: '7:00 PM',
  homeTeam: { abbreviation: 'TOR' }, awayTeam: { abbreviation: 'MTL' },
};

vi.mock('./nhlApiClient', () => ({
  fetchLiveGames:   vi.fn(async () => []),
  fetchGamesByDate: vi.fn(async () => [GAME]),
  fetchTopPlayers:  vi.fn(async () => [
    { id: '10', name: 'Known Star', teamId: 'tor' },
    { id: '11', name: 'Rookie',     teamId: 'mtl' },
  ]),
}));

// Règles : le visiteur et l'under sont très BAS, tout le reste haut.
vi.mock('./predictionEngine', () => ({
  predictMoneyline:   vi.fn(async (_s: string, _o: string, isHome: boolean) => (isHome ? 70 : 30)),
  predictTotalGoals:  vi.fn(async () => 60),
  predictPuckLine:    vi.fn(async () => 40),
  predictAnytimeGoal: vi.fn(async () => 50),
  predictShotsOU:     vi.fn(async () => 55),
  predictPointsOU:    vi.fn(async () => 65),
  predictPPPoint:     vi.fn(async () => 35),
}));

const predictGame = vi.fn();
vi.mock('./mlApiClient', () => ({ mlApiClient: { predictGame: (f: any) => predictGame(f) } }));
vi.mock('./featureEngineering', () => ({ buildGameFeatures: vi.fn(async () => ({})) }));
vi.mock('./oddsClient', () => ({
  priceForSelection: vi.fn(async ({ marketType, selectionValue }: any) =>
    marketType === 'moneyline' && selectionValue === 'mtl' ? { price: 3.2, bookTitle: 'BetRivers' } : null),
}));

const bundle = { value: null as any };
vi.mock('./gameMlBundle', async () => {
  const real = await vi.importActual<typeof import('./gameMlBundle')>('./gameMlBundle');
  return {
    mlBundleKey: real.mlBundleKey,
    getGameMlBundle: vi.fn(async () => { if (!bundle.value) throw new Error('ML down'); return bundle.value; }),
  };
});

import { getBestBets, _clearBestBetsCache } from './bestBets.service';
import { mlBundleKey } from './gameMlBundle';
import { probAtLeast } from './prediction/playerRates';

const k = mlBundleKey;
beforeEach(() => {
  _clearBestBetsCache();
  predictGame.mockReset();
  predictGame.mockRejectedValue(new Error('pas appelé'));
  bundle.value = {
    byKey: {
      // Le ML voit le VISITEUR favori, à l'inverse des règles.
      [k('moneyline', null, null, true)]:  { probability: 41, probability_exact: 0.4123 },
      [k('moneyline', null, null, false)]: { probability: 59, probability_exact: 0.5877 },
      [k('total_goals_over', 5.5, null, true)]:  { probability: 52 },
      [k('total_goals_under', 5.5, null, true)]: { probability: 48 },
      [k('puck_line', -1.5, null, true)]: { probability: 22 },
    },
    playerRates: { '10': { goals: 0.45, shots: 3.4, points: 1.1, ppPoints: 0.4 } },
    playerDispersion: { goals: null, shots: 20, points: null, ppPoints: null },
  };
});

describe('getBestBets — score ML depuis le paquet du match', () => {
  it('TOUS les candidats sont chiffrés, pas seulement les premiers selon les règles', async () => {
    // mlDepth=1 : l'ancien code n'aurait chiffré que le 1er candidat des règles.
    const r = await getBestBets({ source: 'ml', mlDepth: 1, days: 1 });
    const away = r.bets.find((b) => b.id === 'bb-g1-ml-away')!;
    expect(away.rulePct).toBe(30);       // très bas selon les règles…
    expect(away.mlPct).toBe(59);         // …mais chiffré, et par le paquet
    expect(away.source).toBe('ml');
    expect(r.bets.find((b) => b.id === 'bb-g1-ml-home')!.mlPct).toBe(41);
    expect(predictGame).not.toHaveBeenCalled();   // tout venait du paquet
  });

  it('pari joueur : le modèle joueur du paquet, comme sur la page du match', async () => {
    const r = await getBestBets({ source: 'ml', days: 1 });
    const atg = r.bets.find((b) => b.id === 'bb-p-10-atg')!;
    expect(atg.mlPct).toBe(Math.round(probAtLeast(0.45, 1, null) * 100));
    const shots = r.bets.find((b) => b.id === 'bb-p-10-shots')!;   // plus de 2,5 tirs → 3+
    expect(shots.mlPct).toBe(Math.round(probAtLeast(3.4, 3, 20) * 100));
  });

  it('joueur inconnu du modèle : pas de score ML, classé APRÈS tous les paris chiffrés', async () => {
    const r = await getBestBets({ source: 'ml', days: 1 });
    const rookie = r.bets.filter((b) => b.playerId === '11');
    expect(rookie.length).toBeGreaterThan(0);
    expect(rookie.every((b) => b.mlPct === null && b.source === 'rules')).toBe(true);
    const lastMl = r.bets.map((b) => b.source).lastIndexOf('ml');
    const firstRules = r.bets.findIndex((b) => b.source === 'rules');
    expect(lastMl).toBeLessThan(firstRules);
  });

  it('EV calculée quand un prix existe, pour information', async () => {
    const r = await getBestBets({ source: 'ml', days: 1 });
    const away = r.bets.find((b) => b.id === 'bb-g1-ml-away')!;
    expect(away.bookPrice).toBe(3.2);
    expect(away.ev).toBeCloseTo(0.59 * 3.2 - 1, 4);
    expect(r.bets.find((b) => b.id === 'bb-g1-ml-home')!.ev).toBeNull();
  });

  it('question absente du paquet : appel dédié au service ML', async () => {
    delete bundle.value.byKey[k('puck_line', -1.5, null, true)];
    predictGame.mockResolvedValue({ probability: 27 });
    const r = await getBestBets({ source: 'ml', days: 1 });
    expect(r.bets.find((b) => b.id === 'bb-g1-pl-home')!.mlPct).toBe(27);
  });

  it('service ML en panne : la règle seule, sans erreur', async () => {
    bundle.value = null;
    predictGame.mockRejectedValue(new Error('ML down'));
    const r = await getBestBets({ source: 'ml', days: 1 });
    expect(r.meta.mlAvailable).toBe(false);
    expect(r.bets.every((b) => b.mlPct === null && b.source === 'rules')).toBe(true);
  });
});
