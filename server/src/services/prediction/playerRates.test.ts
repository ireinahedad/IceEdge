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
  fetchGameById: vi.fn(async () => ({ homeTeam: { abbreviation: 'MTL' }, awayTeam: { abbreviation: 'BOS' } })),
  fetchTeamRoster: vi.fn(async (a: string) => roster(a)),
  fetchTeamByAbbr: vi.fn(async (a: string) => (a === 'MTL'
    ? { goalsForPerGame: 3.1, goalsAgainstPerGame: 3.0 }
    : { goalsForPerGame: 2.9, goalsAgainstPerGame: 3.4 })),
  fetchTeamSummaryStats: vi.fn(async () => ({ MTL: { shotsForPg: 29, shotsAgainstPg: 31 }, BOS: { shotsForPg: 33, shotsAgainstPg: 28 } })),
}));

import { playerRatesForGame, DISPERSION } from './playerRates';

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
});
