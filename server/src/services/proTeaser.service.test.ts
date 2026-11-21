import { describe, it, expect, vi, beforeEach } from 'vitest';

const getBestBets = vi.fn();
const getBestParlays = vi.fn();
const getLeaderboard = vi.fn();
vi.mock('./bestBets.service', () => ({ getBestBets: (...a: unknown[]) => getBestBets(...a) }));
vi.mock('./bestParlays.service', () => ({
  getBestParlays: (...a: unknown[]) => getBestParlays(...a),
  gateBestParlays: (r: any) => ({ ...r, meta: { ...r.meta, freeCount: 2, total: r.parlays.length } }),
}));
vi.mock('./profile.service', () => ({ getLeaderboard: () => getLeaderboard() }));
vi.mock('../logger', () => ({ logger: { warn: vi.fn() } }));

import { getProTeaser, _resetProTeaserCache } from './proTeaser.service';

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const PAST   = new Date(Date.now() - 3_600_000).toISOString();

const bet = (id: string, pct: number, start = FUTURE) => ({
  id, marketType: 'moneyline', marketLabel: 'Moneyline', rulePct: pct - 5, mlPct: pct,
  label: 'BOS to win', selection: 'BOS', selectionValue: 'BOS', selectionShort: 'BOS',
  subjectName: 'BOS vs NYR', teamAbbr: 'BOS', context: 'vs NYR · 7:00 PM ET',
  game: { date: '2026-11-22', startTimeUTC: start, home: 'BOS', away: 'NYR' },
});

beforeEach(() => {
  _resetProTeaserCache();
  getBestBets.mockReset(); getBestParlays.mockReset(); getLeaderboard.mockReset();
});

describe('getProTeaser', () => {
  it('ne renvoie que marché, match neutre et probabilité — jamais le choix', async () => {
    getBestBets.mockResolvedValue({ bets: [bet('a', 70), bet('b', 80), bet('c', 60), bet('d', 75), bet('old', 99, PAST)] });
    getBestParlays.mockResolvedValue({ parlays: [1, 2, 3, 4, 5], meta: {} });
    getLeaderboard.mockResolvedValue([]);

    const r = await getProTeaser();
    expect(r.tonight!.count).toBe(4);                       // le match commencé est exclu
    expect(r.tonight!.bets.map((b) => b.id)).toEqual(['b', 'd', 'a']);
    expect(r.tonight!.parlays).toEqual({ total: 5, free: 2 });
    const json = JSON.stringify(r);
    for (const leak of ['BOS to win', 'selection', 'context', 'vs NYR', 'teamAbbr', 'subjectName', 'label"']) {
      expect(json).not.toContain(leak);
    }
    expect(r.tonight!.bets[0]).toMatchObject({ matchup: 'NYR @ BOS', pct: 80 });
  });

  it('top 3 du classement sans identifiant ni avatar, paris réglés seulement', async () => {
    getBestBets.mockRejectedValue(new Error('ml down'));
    getBestParlays.mockRejectedValue(new Error('ml down'));
    getLeaderboard.mockResolvedValue([
      { rank: 1, userId: 'u1', username: 'a', displayName: 'Alice', avatarUrl: 'x', hitRate: 60, totalBets: 10 },
      { rank: 2, userId: 'u2', username: 'bob', displayName: null, avatarUrl: null, hitRate: 0, totalBets: 0 },
      { rank: 3, userId: 'u3', username: 'carl', displayName: null, avatarUrl: null, hitRate: 55, totalBets: 4 },
    ]);
    const r = await getProTeaser();
    expect(r.tonight).toBeNull();                           // une moitié en panne n'efface pas l'autre
    expect(r.leaders).toEqual([
      { rank: 1, name: 'Alice', hitRate: 60, totalBets: 10 },
      { rank: 3, name: 'carl', hitRate: 55, totalBets: 4 },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/userId|avatar|u1/);
  });

  it('garde le résultat 60 s en mémoire', async () => {
    getBestBets.mockResolvedValue({ bets: [] });
    getBestParlays.mockResolvedValue({ parlays: [], meta: {} });
    getLeaderboard.mockResolvedValue([]);
    await getProTeaser(); await getProTeaser();
    expect(getBestBets).toHaveBeenCalledTimes(1);
  });
});
