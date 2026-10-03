import { describe, it, expect, vi } from 'vitest';

/**
 * Cadences joueur du mode ML (`playerRates.ts`) — ce qui a motivé le module :
 * deux joueurs très différents recevaient le même 5 % sur « 2+ buts », parce
 * que le service Python bornait une Poisson de saison à [5 %, 95 %].
 */

const { roster } = vi.hoisted(() => ({
  roster: (team: string) => team === 'MTL'
    ? [
        // Profil « Demidov » : marqueur. Profil « Danault » : défensif.
        { id: '1', name: 'Scorer',  position: 'R', gamesPlayed: 60, goals: 24, assists: 30, points: 54, shots: 170, hits: 40,  blockedShots: 20 },
        { id: '2', name: 'Checker', position: 'C', gamesPlayed: 60, goals: 8,  assists: 14, points: 22, shots: 90,  hits: 90,  blockedShots: 45 },
        // Aucun point en 60 matchs, et aucun point en 3 matchs.
        { id: '3', name: 'Zero60',  position: 'L', gamesPlayed: 60, goals: 0,  assists: 0,  points: 0,  shots: 30,  hits: 60,  blockedShots: 10 },
        { id: '4', name: 'Zero3',   position: 'L', gamesPlayed: 3,  goals: 0,  assists: 0,  points: 0,  shots: 2,   hits: 3,   blockedShots: 1 },
        { id: '5', name: 'Goalie',  position: 'G', gamesPlayed: 40, goals: 0,  assists: 0,  points: 0,  shots: 0, shotsAgainst: 1200, goalsAgainst: 110 },
        // Tirs bloqués non publiés par l'amont.
        { id: '6', name: 'NoRealtime', position: 'D', gamesPlayed: 50, goals: 3, assists: 12, points: 15, shots: 70 },
      ]
    : [{ id: '9', name: 'Other', position: 'C', gamesPlayed: 60, goals: 20, assists: 20, points: 40, shots: 150, hits: 30, blockedShots: 20 }],
}));

vi.mock('../nhlApiClient', () => ({
  fetchPlayerById: vi.fn(async () => ({ id: '1', name: 'Scorer', teamAbbr: 'MTL', position: 'R', gamesPlayed: 60, goals: 24, assists: 30, points: 54, shots: 170, hits: 40, blockedShots: 20, penaltyMinutes: 30, ppPoints: 15 })),
  fetchGameById: vi.fn(async () => ({ homeTeam: { abbreviation: 'MTL' }, awayTeam: { abbreviation: 'BOS' } })),
  fetchTeamRoster: vi.fn(async (a: string) => roster(a)),
  fetchTeamByAbbr: vi.fn(async (a: string) => (a === 'MTL'
    ? { goalsForPerGame: 3.1, goalsAgainstPerGame: 3.0 }
    : { goalsForPerGame: 2.9, goalsAgainstPerGame: 3.4 })),
  fetchTeamSummaryStats: vi.fn(async () => ({ MTL: { shotsForPg: 29, shotsAgainstPg: 31 }, BOS: { shotsForPg: 33, shotsAgainstPg: 28 } })),
}));

// Paquet ML du match : le modèle joueur ne connaît que le joueur 2 (« Checker »).
const bundle = vi.hoisted(() => ({ value: null as any }));
vi.mock('../gameMlBundle', () => ({ getGameMlBundle: vi.fn(async () => {
  if (!bundle.value) throw new Error('ML down');
  return bundle.value;
}) }));

import { playerRatesForGame, playerRatesForPlayer, DISPERSION } from './playerRates';

/** P(X ≥ k), binomiale négative — la même formule que le client. */
function atLeast(lam: number, k: number, d: number | null): number {
  if (d == null) { let t = Math.exp(-lam), c = t; for (let i = 1; i < k; i++) { t *= lam / i; c += t; } return 1 - c; }
  const q = lam / (d + lam); let t = Math.pow(d / (d + lam), d), c = t;
  for (let n = 0; n < k - 1; n++) { t *= ((n + d) / (n + 1)) * q; c += t; }
  return 1 - c;
}

describe('playerRatesForGame', () => {
  it('un marqueur et un joueur défensif n\'ont plus le même « 2+ buts »', async () => {
    const r = await playerRatesForGame('2026020001');
    const s = atLeast(r.players['1'].rates.goals!, 2, DISPERSION.goals);
    const c = atLeast(r.players['2'].rates.goals!, 2, DISPERSION.goals);
    expect(Math.round(s * 100)).toBeGreaterThan(Math.round(c * 100));
    expect(c).toBeLessThan(0.05);   // sous l'ancien plancher Python
  });

  it('0 point en 60 matchs → très bas ; 0 point en 3 matchs → on ne sait pas encore', async () => {
    const r = await playerRatesForGame('2026020001');
    const p60 = atLeast(r.players['3'].rates.points!, 2, DISPERSION.points);
    const p3  = atLeast(r.players['4'].rates.points!, 2, DISPERSION.points);
    expect(p60).toBeLessThan(0.03);
    expect(p3).toBeGreaterThan(p60);
  });

  it('les deux alignements, l\'adversaire pris en compte', async () => {
    const r = await playerRatesForGame('2026020001');
    expect(r.players['9'].team).toBe('BOS');
    // BOS concède 3.4 buts/match : les buts de MTL montent au-dessus de la
    // cadence rétrécie seule.
    const shrunk = (24 + 12 * 0.16) / (60 + 12);
    expect(r.players['1'].rates.goals!).toBeGreaterThan(shrunk);
  });

  it('gardien : arrêts seulement ; statistique non publiée : pas de cadence', async () => {
    const r = await playerRatesForGame('2026020001');
    expect(Object.keys(r.players['5'].rates)).toEqual(['saves']);
    expect(r.players['5'].rates.saves!).toBeGreaterThan(20);
    expect(r.players['6'].rates.blocks).toBeUndefined();
    expect(r.players['6'].rates.goals).toBeDefined();
  });

  it('premier buteur : bien sous « 1+ but », et plus haut pour le marqueur', async () => {
    const r = await playerRatesForGame('2026020001');
    const s = r.players['1'];
    expect(s.firstGoal!).toBeLessThan(atLeast(s.rates.goals!, 1, DISPERSION.goals));
    expect(s.firstGoal!).toBeGreaterThan(r.players['2'].firstGoal!);
  });

  it('page joueur : pénalités et points en AN, adversaire du match choisi', async () => {
    const withGame = await playerRatesForPlayer('1', '2026020001');
    const noGame   = await playerRatesForPlayer('1');
    const r = withGame.players['1'];
    expect(r.rates.pim).toBeGreaterThan(0);
    expect(r.rates.ppPoints).toBeGreaterThan(0);
    // BOS concède 3.4 buts/match : ajusté au-dessus de la version sans match.
    expect(r.rates.goals!).toBeGreaterThan(noGame.players['1'].rates.goals!);
    expect(withGame.gameId).toBe('2026020001');
    expect(noGame.gameId).toBeUndefined();
  });

  it('modèle joueur : remplace la règle pour les joueurs qu\'il connaît, pas pour les autres', async () => {
    bundle.value = {
      playerRates: { '2': { goals: 0.31, assists: 0.2, points: 0.5, shots: 2.2, hits: 1.4, blocks: 0.6, pim: 0.4, ppPoints: 0.05 },
                     '5': { goals: 9 } },   // un gardien : ignoré
      playerDispersion: { goals: null, shots: 20 }, playerModelAsOf: '2026-04-16',
    };
    const r = await playerRatesForGame('2026020001');
    bundle.value = null;
    expect(r.players['2'].source).toBe('model');
    expect(r.players['2'].rates.goals).toBe(0.31);
    expect(r.players['2'].rates.pim).toBe(0.4);           // absent de l'effectif, fourni par le modèle
    expect(r.players['1'].source).toBe('rules');
    expect(r.players['5'].source).toBe('rules');
    expect(r.players['5'].rates.goals).toBeUndefined();
    expect(r.modelDispersion).toEqual({ goals: null, shots: 20 });
    // Premier buteur recalculé sur la cadence du modèle.
    expect(r.players['2'].firstGoal!).toBeGreaterThan(0);
  });

  it('premier buteur : buts de match du MODÈLE DE SCORE pour tous les joueurs (INCOHERENCES_ML §13)', async () => {
    bundle.value = {
      lambdaHome: 3.4, lambdaAway: 2.4,
      playerRates: { '2': { goals: 0.31 } },
      playerDispersion: { goals: null }, playerModelAsOf: '2026-04-16',
    };
    const r = await playerRatesForGame('2026020001');
    bundle.value = null;
    const any = 1 - Math.exp(-5.8);
    // Joueur du modèle : sa cadence ÷ λ du modèle de score.
    expect(r.players['2'].gameGoals).toBe(5.8);
    expect(r.players['2'].firstGoal!).toBeCloseTo((0.31 / 5.8) * any, 4);
    // Joueur de la règle, même match : même dénominateur.
    expect(r.players['1'].gameGoals).toBe(5.8);
    expect(r.players['1'].firstGoal!).toBeCloseTo((r.players['1'].rates.goals! / 5.8) * any, 4);
    expect(r.players['9'].gameGoals).toBe(5.8);
    // Gardien : jamais de premier buteur.
    expect(r.players['5'].firstGoal).toBeUndefined();
  });

  it('paquet sans λ : buts de match de la règle, comme avant', async () => {
    bundle.value = { playerRates: { '2': { goals: 0.31 } }, playerDispersion: {}, playerModelAsOf: null };
    const withModel = await playerRatesForGame('2026020001');
    bundle.value = null;
    const rules = await playerRatesForGame('2026020001');
    expect(withModel.players['1'].gameGoals).toBe(rules.players['1'].gameGoals);
  });

  it('service ML en panne : la règle seule, sans erreur', async () => {
    bundle.value = null;
    const r = await playerRatesForGame('2026020001');
    expect(Object.values(r.players).every(p => p.source === 'rules')).toBe(true);
    expect(r.modelDispersion).toBeUndefined();
  });
});
