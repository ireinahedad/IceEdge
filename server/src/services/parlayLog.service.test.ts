import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Journal des combinés publiés (MARKETING_PLAN Phase B) : gel idempotent,
 * règlement d'un combiné avec une jambe annulée, bilan cumulé.
 */

const query = vi.fn(async (..._a: unknown[]): Promise<any> => ({ rows: [], rowCount: 0 }));
const clientQuery = vi.fn(async (..._a: unknown[]): Promise<any> => ({ rows: [], rowCount: 0 }));
const release = vi.fn();
const getBestParlays = vi.fn();
const settleStandaloneLegs = vi.fn(async (legs: any[]) => legs.map(() => 'unknown'));

vi.mock('../db/connection', () => ({
  pool: {
    query: (...a: unknown[]) => query(...a),
    connect: async () => ({ query: (...a: unknown[]) => clientQuery(...a), release }),
  },
}));
vi.mock('./bestParlays.service', () => ({ FREE_PARLAYS: 2, getBestParlays: (d: string) => getBestParlays(d) }));
vi.mock('./settlement.service', () => ({
  settleStandaloneLegs: (l: any[]) => settleStandaloneLegs(l),
  // Même règle que la vraie (testée dans settlement.service.test.ts).
  resolveSlipOutcome: (r: string[]) => {
    if (r.length === 0) return null;
    if (r.includes('loss')) return 'loss';
    if (r.includes('unknown')) return null;
    if (r.some((x) => x === 'win')) return 'win';
    return 'void';
  },
}));
vi.mock('../logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

import {
  freezeDailyParlays, settlePendingParlays, getParlayRecord, markParlaysPosted, etToday,
} from './parlayLog.service';

function leg(over: Partial<any> = {}): any {
  return {
    id: 'bb-1-ml', subjectType: 'game', marketType: 'moneyline', selectionValue: 'bos', line: null,
    subjectId: '2025020001', gameId: '2025020001', playerId: null, score: 62,
    game: { date: '2026-10-22', startTimeUTC: '2026-10-22T23:00:00Z', home: 'BOS', away: 'NYR' },
    ...over,
  };
}
function parlay(id: string, legs = [leg(), leg({ id: 'bb-2-ml', gameId: '2025020002', subjectId: '2025020002',
  game: { date: '2026-10-22', startTimeUTC: '2026-10-22T22:00:00Z', home: 'TOR', away: 'MTL' } })]): any {
  return { id, kind: 'moneyline', legs, probability: 31.4, bookPrice: 4.2, assumesIndependence: false, coherentPairs: 0 };
}
const frozenRow = (rank: number) => ({
  date: '2026-10-22', rank, parlay_id: `p${rank}`, kind: 'mixed', legs: [leg()], probability: '30.1',
  book_price: null, first_start_utc: '2026-10-22T23:00:00Z', frozen_at: '2026-10-22T20:00:00Z',
  status: 'pending', leg_results: null, settled_at: null,
  youtube_pick_id: null, youtube_result_id: null, tiktok_pick_sent_at: null, tiktok_result_sent_at: null,
});

beforeEach(() => {
  query.mockReset(); query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  clientQuery.mockReset(); clientQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  getBestParlays.mockReset(); settleStandaloneLegs.mockReset(); release.mockReset();
});

describe('etToday', () => {
  it('donne le jour NHL (heure de l’Est), pas le jour UTC', () => {
    // 2026-10-23 02:00 UTC = 22 h le 22 à New York.
    expect(etToday(new Date('2026-10-23T02:00:00Z'))).toBe('2026-10-22');
    expect(etToday(new Date('2026-10-23T02:00:00Z'), 1)).toBe('2026-10-23');
  });
});

describe('freezeDailyParlays', () => {
  it('gèle les 2 premiers combinés seulement, rang = position + 1, première mise au jeu', async () => {
    getBestParlays.mockResolvedValueOnce({ parlays: [parlay('a'), parlay('b'), parlay('c')], meta: { day: '2026-10-22' } });
    const out = await freezeDailyParlays('2026-10-22');
    const inserts = clientQuery.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO parlay_log'));
    expect(inserts).toHaveLength(2);
    const p1 = inserts[0][1] as any[];
    expect(p1.slice(0, 4)).toEqual(['2026-10-22', 1, 'a', 'moneyline']);
    expect(JSON.parse(p1[4])).toHaveLength(2);
    expect(p1[7]).toBe('2026-10-22T22:00:00.000Z');       // la plus tôt des deux jambes
    expect((inserts[1][1] as any[])[1]).toBe(2);
    expect(clientQuery.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true);
    expect(out.created).toBe(true);
    expect(release).toHaveBeenCalled();
  });

  it('idempotent : un jour déjà gelé n’est jamais recalculé ni réécrit', async () => {
    query.mockResolvedValueOnce({ rows: [frozenRow(1), frozenRow(2)] });
    const out = await freezeDailyParlays('2026-10-22');
    expect(out.created).toBe(false);
    expect(out.parlays.map((p) => p.parlayId)).toEqual(['p1', 'p2']);
    expect(getBestParlays).not.toHaveBeenCalled();
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('course entre deux runs : celui qui arrive second sous le verrou n’écrit rien', async () => {
    getBestParlays.mockResolvedValueOnce({ parlays: [parlay('a')], meta: { day: '2026-10-22' } });
    clientQuery.mockImplementation(async (sql: any) =>
      String(sql).startsWith('SELECT 1') ? { rows: [{ '?column?': 1 }] } : { rows: [], rowCount: 0 });
    const out = await freezeDailyParlays('2026-10-22');
    expect(out.created).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT'))).toBe(false);
  });

  it('aucun combiné ce soir → rien d’écrit', async () => {
    getBestParlays.mockResolvedValueOnce({ parlays: [], meta: { day: null } });
    const out = await freezeDailyParlays('2026-10-22');
    expect(out).toEqual({ date: '2026-10-22', created: false, parlays: [] });
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('refuse (409) des combinés d’un autre jour', async () => {
    getBestParlays.mockResolvedValueOnce({ parlays: [parlay('a')], meta: { day: '2026-10-23' } });
    await expect(freezeDailyParlays('2026-10-22')).rejects.toMatchObject({ status: 409 });
  });
});

describe('settlePendingParlays', () => {
  it('jambe annulée sortie du calcul → gagné ; une jambe perdue → perdu ; indécis → reste en attente', async () => {
    const player = leg({ subjectType: 'player', subjectId: 'x', playerId: '8478402', marketType: 'anytime_goal', selectionValue: 'yes' });
    query.mockResolvedValueOnce({ rows: [
      { id: '1', legs: [leg(), player] },      // win + void      → won
      { id: '2', legs: [leg(), leg()] },       // loss + unknown  → lost
      { id: '3', legs: [leg()] },              // unknown         → pending
    ] });
    query.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
    settleStandaloneLegs.mockResolvedValueOnce(['win', 'void', 'loss', 'unknown', 'unknown']);

    const out = await settlePendingParlays(Date.parse('2026-10-23T12:00:00Z'));
    expect(out).toEqual({ checked: 3, settled: 2 });
    // Le pari joueur est réglé sur l'id du JOUEUR.
    expect((settleStandaloneLegs.mock.calls[0][0] as any[])[1].subjectId).toBe('8478402');

    const updates = query.mock.calls.slice(1).map(([, p]) => p as any[]);
    expect(updates[0]).toEqual(['1', JSON.stringify(['win', 'void']), 'won']);
    expect(updates[1]).toEqual(['2', JSON.stringify(['loss', 'unknown']), 'lost']);
    expect(updates[2]).toEqual(['3', JSON.stringify(['unknown']), 'pending']);
  });

  it('rien en attente → aucun appel de règlement', async () => {
    expect(await settlePendingParlays()).toEqual({ checked: 0, settled: 0 });
    expect(settleStandaloneLegs).not.toHaveBeenCalled();
  });
});

describe('getParlayRecord', () => {
  it('taux = gagnés / (gagnés + perdus), annulés et en attente à part', async () => {
    query.mockResolvedValueOnce({ rows: [{ since: '2026-10-23', won: '12', lost: '9', void: '1', pending: '2' }] });
    expect(await getParlayRecord()).toEqual({ since: '2026-10-23', won: 12, lost: 9, void: 1, pending: 2, winPct: 57.1 });
  });

  it('avant le lancement : pas de taux inventé', async () => {
    query.mockResolvedValueOnce({ rows: [{ since: null, won: '0', lost: '0', void: '0', pending: '0' }] });
    expect((await getParlayRecord()).winPct).toBeNull();
  });
});

describe('markParlaysPosted', () => {
  it('pose l’id YouTube une seule fois', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    expect(await markParlaysPosted('2026-10-22', 'youtube_pick', 'abc123')).toEqual({ updated: 2, alreadySet: false });
    expect(String(query.mock.calls[0][0])).toContain('youtube_pick_id IS NULL');
  });

  it('déjà posé → alreadySet (le workflow ne republie pas)', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    query.mockResolvedValueOnce({ rows: [{ n: '2' }] });
    expect(await markParlaysPosted('2026-10-22', 'tiktok_result')).toEqual({ updated: 0, alreadySet: true });
  });

  it('jour jamais gelé → 404 ; YouTube sans id → 400', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    query.mockResolvedValueOnce({ rows: [{ n: '0' }] });
    await expect(markParlaysPosted('2026-10-22', 'tiktok_pick')).rejects.toMatchObject({ status: 404 });
    await expect(markParlaysPosted('2026-10-22', 'youtube_result')).rejects.toMatchObject({ status: 400 });
  });
});
