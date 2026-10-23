import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Ce qui compte : l'heure LNH décide (pas le client), panne LNH = vote refusé,
 * totaux en cache 1 min mais vidés par un vote, rien d'écrit sur un refus.
 */

const queries: Array<{ sql: string; params: unknown[] }> = [];
let tallyRows: Array<{ team_abbr: string; n: number }> = [];
let myRows: Array<{ team_abbr: string }> = [];
vi.mock('../db/connection', () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: sql.trim().split(/\s+/).slice(0, 2).join(' '), params });
      if (sql.includes('COUNT(*)')) return { rows: tallyRows };
      if (sql.includes('SELECT team_abbr FROM')) return { rows: myRows };
      return { rows: [], rowCount: 1 };
    },
  },
}));

let gameImpl: () => Promise<any>;
vi.mock('./nhlApiClient', () => ({ fetchGameById: () => gameImpl() }));

const START = Date.now() + 2 * 60 * 60_000;
const nhlGame = (over: Record<string, unknown> = {}) => ({
  homeTeam: { abbreviation: 'STL' }, awayTeam: { abbreviation: 'VGK' },
  startTimeUTC: new Date(START).toISOString(), status: 'scheduled', ...over,
});

async function load() {
  const m = await import('./pickem.service');
  m.clearPickemCache();
  return m;
}

describe('pickem.service', () => {
  beforeEach(() => {
    queries.length = 0;
    tallyRows = [{ team_abbr: 'STL', n: 4 }, { team_abbr: 'VGK', n: 8 }];
    myRows = [];
    gameImpl = async () => nhlGame();
  });

  it('lecture anonyme : totaux seulement, pas de lecture du vote personnel', async () => {
    const { getPickem } = await load();
    const s = await getPickem('2026020123');
    expect(s).toMatchObject({ total: 12, enough: true, locked: false, myVote: null });
    expect(s.away.pct).toBe(67);
    expect(queries.map((q) => q.sql)).toEqual(['SELECT team_abbr,']);
  });

  it('totaux en cache 1 min : 2e lecture sans requête de totaux', async () => {
    const { getPickem } = await load();
    await getPickem('2026020123');
    await getPickem('2026020123', 'u1');
    expect(queries.filter((q) => q.sql === 'SELECT team_abbr,')).toHaveLength(1);
  });

  it('vote : UPSERT avec l’heure LNH, cache vidé, état renvoyé', async () => {
    const { getPickem, castPickem } = await load();
    await getPickem('2026020123');
    tallyRows = [{ team_abbr: 'STL', n: 4 }, { team_abbr: 'VGK', n: 9 }];
    const s = await castPickem('u1', '2026020123', 'VGK');
    const up = queries.find((q) => q.sql === 'INSERT INTO')!;
    expect(up.params).toEqual(['u1', '2026020123', 'VGK', new Date(START).toISOString()]);
    expect(s).toMatchObject({ total: 13, myVote: 'VGK' });
  });

  it('équipe hors match : 400, rien écrit', async () => {
    const { castPickem } = await load();
    await expect(castPickem('u1', '2026020123', 'BOS')).rejects.toMatchObject({ status: 400, code: 'BAD_TEAM' });
    expect(queries).toEqual([]);
  });

  it('match commencé (heure prévue passée) : 409, rien écrit', async () => {
    gameImpl = async () => nhlGame({ startTimeUTC: new Date(Date.now() - 60_000).toISOString() });
    const { castPickem } = await load();
    await expect(castPickem('u1', '2026020123', 'VGK')).rejects.toMatchObject({ status: 409, code: 'GAME_STARTED' });
    expect(queries).toEqual([]);
  });

  it('API LNH muette : 503, rien écrit (fermé en cas de panne)', async () => {
    gameImpl = async () => { throw new Error('NHL API timeout'); };
    const { castPickem } = await load();
    await expect(castPickem('u1', '2026020123', 'VGK')).rejects.toMatchObject({ status: 503 });
    expect(queries).toEqual([]);
  });

  it('match inconnu : 404', async () => {
    gameImpl = async () => { throw Object.assign(new Error('Game not found'), { status: 404 }); };
    const { getPickem } = await load();
    await expect(getPickem('2026020999')).rejects.toMatchObject({ status: 404 });
  });

  it('connecté : renvoie son vote', async () => {
    myRows = [{ team_abbr: 'STL' }];
    const { getPickem } = await load();
    expect((await getPickem('2026020123', 'u1')).myVote).toBe('STL');
  });
});
