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

import { fetchHeadToHead, fetchHeadToHeadSeason } from './teamSeasons';
import { fetchNHL } from './core';

describe('fetchHeadToHead', () => {
  it('matchs joués contre CET adversaire seulement, du plus récent au plus ancien, vus du club', async () => {
    const h = await fetchHeadToHead('tor', 'MTL');
    expect(h).toEqual([
      { gameId: '3', date: '2026-10-20', isHome: false, goalsFor: 3, goalsAgainst: 4, lastPeriodType: 'OT' },
      { gameId: '1', date: '2026-04-28', isHome: true,  goalsFor: 5, goalsAgainst: 2, lastPeriodType: 'REG' },
    ]);
  });
});

describe('fetchHeadToHeadSeason', () => {
  it('toute la saison demandée, saison régulière + séries, sans préparatoire ni match à venir', async () => {
    const prev = await fetchHeadToHeadSeason('tor', 'mtl', '20252026');
    expect(prev).toEqual({ season: '20252026', games: [
      { gameId: '1', date: '2026-04-28', homeAbbr: 'TOR', awayAbbr: 'MTL', homeScore: 5, awayScore: 2, gameType: 3, lastPeriodType: 'REG' },
    ] });

    const cur = await fetchHeadToHeadSeason('TOR', 'MTL', '20262027');
    expect(cur.games.map((g) => g.gameId)).toEqual(['3']);
    expect(cur.games[0]).toMatchObject({ homeAbbr: 'MTL', awayAbbr: 'TOR', lastPeriodType: 'OT', gameType: 2 });
  });

  // Un club absent de la saison (franchise relocalisée) : liste vide, pas d'erreur.
  it('404 de l\'amont = aucune rencontre', async () => {
    vi.mocked(fetchNHL).mockRejectedValueOnce(Object.assign(new Error('NHL API 404'), { status: 404 }));
    expect(await fetchHeadToHeadSeason('UTA', 'MTL', '20232024')).toEqual({ season: '20232024', games: [] });
  });

  // Toute autre panne remonte : « aucune rencontre » serait une affirmation fausse.
  it('une panne de l\'amont remonte au lieu de rendre une liste vide', async () => {
    vi.mocked(fetchNHL).mockRejectedValueOnce(Object.assign(new Error('NHL API 503'), { status: 503 }));
    await expect(fetchHeadToHeadSeason('TOR', 'MTL', '20252026')).rejects.toThrow('503');
  });
});
