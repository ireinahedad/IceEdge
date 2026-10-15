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
