import { describe, it, expect, vi } from 'vitest';

/**
 * Face-à-face : les derniers matchs JOUÉS entre deux clubs, vus du club
 * demandé. Donnée seule (son poids sera mesuré sur l'historique avant usage) :
 * ce qui compte ici, c'est qu'elle ne contienne rien d'inventé.
 */

const SCHED: Record<string, any> = {
  // Saison en cours : un match joué contre MTL, un à venir, un contre BOS.
  cur: { games: [
    { id: 3, gameType: 2, gameDate: '2026-10-20', homeTeam: { abbrev: 'MTL', score: 4 }, awayTeam: { abbrev: 'TOR', score: 3 }, gameOutcome: { lastPeriodType: 'OT' } },
    { id: 4, gameType: 2, gameDate: '2026-12-01', homeTeam: { abbrev: 'TOR' }, awayTeam: { abbrev: 'MTL' } },
    { id: 5, gameType: 2, gameDate: '2026-10-25', homeTeam: { abbrev: 'TOR', score: 2 }, awayTeam: { abbrev: 'BOS', score: 1 } },
  ] },
  // Saison précédente : un match de séries contre MTL, un préparatoire (exclu).
  prev: { games: [
    { id: 1, gameType: 3, gameDate: '2026-04-28', homeTeam: { abbrev: 'TOR', score: 5 }, awayTeam: { abbrev: 'MTL', score: 2 } },
    { id: 2, gameType: 1, gameDate: '2025-09-28', homeTeam: { abbrev: 'TOR', score: 1 }, awayTeam: { abbrev: 'MTL', score: 0 } },
  ] },
};

vi.mock('./core', () => ({
  currentSeason: () => '20262027',
  previousSeason: () => '20252026',
  fetchNHL: vi.fn(async (path: string) => {
    if (path.endsWith('/20262027')) return SCHED.cur;
    if (path.endsWith('/20252026')) return SCHED.prev;
    throw new Error('unexpected');
  }),
  fetchStats: vi.fn(),
  getCached: vi.fn(() => null),
  setCached: vi.fn(),
  parseToiMinutes: vi.fn(),
}));

import { fetchHeadToHead } from './teamSeasons';

describe('fetchHeadToHead', () => {
  it('matchs joués contre CET adversaire seulement, du plus récent au plus ancien, vus du club', async () => {
    const h = await fetchHeadToHead('tor', 'MTL');
    expect(h).toEqual([
      { gameId: '3', date: '2026-10-20', isHome: false, goalsFor: 3, goalsAgainst: 4, lastPeriodType: 'OT' },
      { gameId: '1', date: '2026-04-28', isHome: true,  goalsFor: 5, goalsAgainst: 2, lastPeriodType: 'REG' },
    ]);
  });
});
