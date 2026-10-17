import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pari joueur demandé à l'unité (`POST /api/predict/ml`, type `player`) :
 * le chiffre vient du MODÈLE JOUEUR (paquet ML du match), plus de la Poisson
 * de saison de `/predict/player` — piste 1 de « Des buts attendus à tous les
 * paris ».
 */

const player = vi.hoisted(() => ({ value: { id: '1', name: 'Scorer', teamAbbr: 'MTL', position: 'R', gamesPlayed: 41 } as any }));
const games = vi.hoisted(() => ([
  { id: '2026020010', status: 'final',     homeTeam: { abbreviation: 'MTL' }, awayTeam: { abbreviation: 'TOR' } },
  { id: '2026020020', status: 'scheduled', homeTeam: { abbreviation: 'BOS' }, awayTeam: { abbreviation: 'NYR' } },
  { id: '2026020030', status: 'scheduled', homeTeam: { abbreviation: 'MTL' }, awayTeam: { abbreviation: 'BOS' } },
  { id: '2026020040', status: 'scheduled', homeTeam: { abbreviation: 'OTT' }, awayTeam: { abbreviation: 'MTL' } },
]));
vi.mock('../nhlApiClient', () => ({
  fetchPlayerById: vi.fn(async () => player.value),
  fetchGamesRange: vi.fn(async () => games),
}));

const bundle = vi.hoisted(() => ({ value: null as any, asked: [] as string[] }));
vi.mock('../gameMlBundle', () => ({ getGameMlBundle: vi.fn(async (id: string) => {
  bundle.asked.push(id);
  if (!bundle.value) throw new Error('ML down');
  return bundle.value;
}) }));

import { predictPlayerFromModel } from './playerModelPrediction';
import { probAtLeast } from './playerRates';

const q = (o: Partial<Parameters<typeof predictPlayerFromModel>[0]> = {}) =>
  ({ playerId: '1', propType: 'goals', line: 0.5, selection: 'over', ...o });

beforeEach(() => {
  player.value = { id: '1', name: 'Scorer', teamAbbr: 'MTL', position: 'R', gamesPlayed: 41 };
  bundle.asked = [];
  bundle.value = {
    playerRates: { '1': { goals: 0.42, shots: 3.1 } },
    playerDispersion: { goals: null, shots: 12 },
    playerModelAsOf: '2026-10-14',
  };
});

describe('predictPlayerFromModel', () => {
  it('lit la cadence du modèle dans le paquet du match demandé', async () => {
    const r = await predictPlayerFromModel(q({ gameId: '2026020099' }));
    expect(bundle.asked).toEqual(['2026020099']);
    const p = probAtLeast(0.42, 1, null);
    expect(r?.probability).toBe(Math.round(p * 100));
    expect(r?.probability_exact).toBeCloseTo(p, 5);
    expect(r?.model_type).toBe('Modèle joueur (XGBoost)');
    expect(r?.model_version).toBe('player-xgb@2026-10-14');
  });

  it('dispersion par profil : le k suit la cadence prévue du joueur', async () => {
    bundle.value = {
      playerRates: { '1': { hits: 0.5 }, '2': { hits: 2.0 } },
      playerDispersion: { hits: 8 },
      playerDispersionTiers: { hits: { cuts: [0.78, 1.39], k: [3, 4, 10] } },
      playerModelAsOf: '2026-10-14',
    };
    const low = await predictPlayerFromModel(q({ gameId: '2026020099', propType: 'hits', line: 1.5 }));
    expect(low?.probability_exact).toBeCloseTo(probAtLeast(0.5, 2, 3), 5);
    player.value = { ...player.value, id: '2' };
    const high = await predictPlayerFromModel(q({ playerId: '2', gameId: '2026020099', propType: 'hits', line: 1.5 }));
    expect(high?.probability_exact).toBeCloseTo(probAtLeast(2.0, 2, 10), 5);
  });

  it('pénalités en nombre : lit l\'échelle P(PIM ≥ m) du paquet, pas la binomiale négative', async () => {
    bundle.value = {
      playerRates: { '1': { pim: 0.44 } },
      playerDispersion: { pim: 0.3 },
      playerPimLadder: { '1': [0.186, 0.186, 0.027, 0.027, 0.01] },
      playerModelAsOf: '2026-10-14',
    };
    const over05 = await predictPlayerFromModel(q({ gameId: '2026020099', propType: 'pim', line: 0.5 }));
    expect(over05?.probability_exact).toBeCloseTo(0.186, 5);
    const over25 = await predictPlayerFromModel(q({ gameId: '2026020099', propType: 'pim', line: 2.5 }));
    expect(over25?.probability_exact).toBeCloseTo(0.027, 5);
    const under25 = await predictPlayerFromModel(q({ gameId: '2026020099', propType: 'pim', line: 2.5, selection: 'under' }));
    expect(under25?.probability_exact).toBeCloseTo(0.97, 5);       // 1 − 0,027, plafonné à 97 %
  });

  it('sans gameId : prochain match NON terminé de l\'équipe du joueur', async () => {
    await predictPlayerFromModel(q());
    expect(bundle.asked).toEqual(['2026020030']);
  });

  it('respecte l\'adversaire et le côté demandés', async () => {
    await predictPlayerFromModel(q({ opponentId: 'ott' }));
    await predictPlayerFromModel(q({ isHome: false }));
    expect(bundle.asked).toEqual(['2026020040', '2026020040']);
  });

  it('« moins de » = complément, avec la dispersion du modèle pour la stat', async () => {
    const r = await predictPlayerFromModel(q({ gameId: '2026020030', propType: 'shots', line: 2.5, selection: 'under' }));
    expect(r?.probability).toBe(Math.round((1 - probAtLeast(3.1, 3, 12)) * 100));
  });

  it('même plafond à 97 que les grilles', async () => {
    bundle.value.playerRates['1'].shots = 9;
    const r = await predictPlayerFromModel(q({ gameId: '2026020030', propType: 'shots', line: 0.5 }));
    expect(r?.probability).toBe(97);
  });

  it('gardien : arrêts du modèle de tirs (paquet → goalieSaves), k des arrêts', async () => {
    player.value = { ...player.value, position: 'G' };
    bundle.value = { ...bundle.value, goalieSaves: { '1': 26 }, savesDispersion: 50 };
    const r = await predictPlayerFromModel(q({ gameId: '2026020030', propType: 'saves', line: 24.5 }));
    expect(r?.probability).toBe(Math.round(probAtLeast(26, 25, 50) * 100));
    expect(r?.model_type).toBe('Modèle de tirs (XGBoost)');
    // Un gardien n'a pas de « buts » ; un patineur pas d'« arrêts ».
    expect(await predictPlayerFromModel(q({ gameId: '2026020030', propType: 'goals' }))).toBeNull();
    player.value = { ...player.value, position: 'C' };
    expect(await predictPlayerFromModel(q({ gameId: '2026020030', propType: 'saves', line: 24.5 }))).toBeNull();
  });

  it('rend null quand le modèle n\'a rien → repli sur /predict/player', async () => {
    // Stat non couverte (gardien), joueur inconnu du modèle, paquet en panne, match en cours.
    expect(await predictPlayerFromModel(q({ propType: 'saves' }))).toBeNull();
    expect(await predictPlayerFromModel(q({ playerId: '2' }))).toBeNull();
    bundle.value = { ...bundle.value, live: { label: '2e', final: false } };
    expect(await predictPlayerFromModel(q())).toBeNull();
    bundle.value = null;
    expect(await predictPlayerFromModel(q())).toBeNull();
    player.value = { ...player.value, position: 'G' };
    expect(await predictPlayerFromModel(q())).toBeNull();
  });
});
