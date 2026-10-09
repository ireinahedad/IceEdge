import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Journal des Best Bets (/dev/profit) : ce qui est écrit, avec quel rang, et
 * comment le règlement passe de « en attente » à gagné / perdu / annulé.
 */

const query = vi.fn(async (..._a: unknown[]): Promise<any> => ({ rows: [], rowCount: 0 }));
const settleStandaloneLegs = vi.fn(async (legs: any[]) => legs.map(() => 'unknown'));

vi.mock('../db/connection', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('./settlement.service', () => ({ settleStandaloneLegs: (l: any[]) => settleStandaloneLegs(l) }));
vi.mock('../logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

import { logBestBets, settlePendingBestBets, BEST_BET_LOG_DEPTH } from './bestBetLog.service';

function bet(over: Partial<any> = {}): any {
  return {
    id: 'bb-2025020001-ml-home', subjectType: 'game', marketType: 'moneyline', marketLabel: 'Moneyline',
    subjectId: '2025020001', subjectName: 'BOS vs NYR', subjectLogo: '', teamAbbr: 'BOS',
    label: 'BOS to win', selection: 'BOS to win', selectionValue: 'bos', selectionShort: 'BOS ML',
    context: '', line: null, gameId: '2025020001', teamId: 'bos', playerId: null,
    rulePct: 60, mlPct: 62, score: 62, source: 'ml', confidence: 'high',
    bookPrice: 1.8, bookTitle: 'BetRivers', ev: 0.116,
    game: { date: '2026-10-15', startTimeUTC: '2026-10-15T23:00:00Z', home: 'BOS', away: 'NYR' },
    ...over,
  };
}

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  settleStandaloneLegs.mockReset();
});

describe('logBestBets', () => {
  it('écrit chaque pari avec son rang (position + 1) et sa cote', async () => {
    await logBestBets([bet(), bet({ id: 'bb-x-over', bookPrice: null })]);
    expect(query).toHaveBeenCalledTimes(2);
    const [, first] = query.mock.calls[0] as [string, any[]];
    expect(first[0]).toBe('bb-2025020001-ml-home');
    expect(first[2]).toBe('2026-10-15');
    expect(first[15]).toBe(1);          // rang
    expect(first[17]).toBe(1.8);        // cote décimale
    const [, second] = query.mock.calls[1] as [string, any[]];
    expect(second[15]).toBe(2);
    expect(second[17]).toBeNull();      // pas de prix → null, pas 0
  });

  it('un pari joueur est réglé sur l’id du JOUEUR', async () => {
    await logBestBets([bet({ id: 'bb-p-8478402-atg', subjectType: 'player', subjectId: '8478402',
                             playerId: '8478402', marketType: 'anytime_goal', selectionValue: 'yes' })]);
    const [, p] = query.mock.calls[0] as [string, any[]];
    expect(p[7]).toBe('8478402');
  });

  it('ignore un pari sans match, et ne dépasse pas la profondeur journalisée', async () => {
    await logBestBets([bet({ gameId: null }), ...Array.from({ length: 40 }, (_, i) => bet({ id: `b${i}` }))]);
    expect(query).toHaveBeenCalledTimes(BEST_BET_LOG_DEPTH - 1);
  });

  it('une base en panne ne lève pas et arrête la boucle', async () => {
    query.mockRejectedValueOnce(new Error('relation "best_bet_log" does not exist'));
    await expect(logBestBets([bet(), bet({ id: 'b2' })])).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('settlePendingBestBets', () => {
  it('écrit les verdicts décidés, laisse « unknown » en attente', async () => {
    query.mockImplementationOnce(async () => ({
      rows: [
        { id: '1', game_id: '2025020001', market_type: 'moneyline', selection_value: 'bos', line: null, subject_id: '2025020001' },
        { id: '2', game_id: '2025020001', market_type: 'total_goals', selection_value: 'over', line: '5.5', subject_id: '2025020001' },
        { id: '3', game_id: '2025020002', market_type: 'anytime_goal', selection_value: 'yes', line: null, subject_id: '8478402' },
      ],
    }));
    query.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
    settleStandaloneLegs.mockResolvedValueOnce(['win', 'unknown', 'void']);

    const r = await settlePendingBestBets();
    expect(r).toEqual({ checked: 3, settled: 2 });

    const legs = settleStandaloneLegs.mock.calls[0][0];
    expect(legs[1]).toMatchObject({ marketType: 'total_goals', selectionValue: 'over', line: 5.5 });
    expect(legs[2]).toMatchObject({ subjectId: '8478402' });

    const updates = query.mock.calls.slice(1).map((c) => (c as [string, any[]])[1]);
    expect(updates).toEqual([['1', 'win'], ['3', 'void']]);
  });

  it('rien en attente : aucun appel au règlement', async () => {
    expect(await settlePendingBestBets()).toEqual({ checked: 0, settled: 0 });
    expect(settleStandaloneLegs).not.toHaveBeenCalled();
  });
});
