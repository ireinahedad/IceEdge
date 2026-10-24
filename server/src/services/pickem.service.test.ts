import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Ce qui compte : l'heure LNH décide (pas le client), panne LNH = vote refusé,
 * totaux en cache 1 min mais vidés par un vote, rien d'écrit sur un refus.
 */

const queries: Array<{ sql: string; params: unknown[] }> = [];
let tallyRows: Array<{ team_abbr: string; n: number }> = [];
let myRows: Array<{ team_abbr: string }> = [];
let dayRows: Array<{ game_id: string; team_abbr: string; n: number }> = [];
let myDayRows: Array<{ game_id: string; team_abbr: string }> = [];
vi.mock('../db/connection', () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: sql.trim().split(/\s+/).slice(0, 2).join(' '), params });
      if (sql.includes('GROUP BY game_id')) return { rows: dayRows };
      if (sql.includes('SELECT game_id, team_abbr FROM')) return { rows: myDayRows };
      if (sql.includes('COUNT(*)')) return { rows: tallyRows };
      if (sql.includes('SELECT team_abbr FROM')) return { rows: myRows };
      return { rows: [], rowCount: 1 };
    },
  },
}));

let gameImpl: () => Promise<any>;
let dayImpl: () => Promise<any[]> = async () => [];
vi.mock('./nhlApiClient', () => ({ fetchGameById: () => gameImpl(), fetchGamesByDate: () => dayImpl() }));

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

describe('getPickemDay (section Votes du chat)', () => {
  const sched = (id: string, home: string, away: string, startMs: number, over: Record<string, unknown> = {}) => ({
    id, status: 'scheduled', startTimeUTC: new Date(startMs).toISOString(),
    homeTeam: { abbreviation: home, score: null }, awayTeam: { abbreviation: away, score: null }, ...over,
  });

  beforeEach(() => {
    queries.length = 0;
    dayRows = [
      { game_id: '2026020200', team_abbr: 'STL', n: 3 }, { game_id: '2026020200', team_abbr: 'VGK', n: 9 },
      { game_id: '2026020201', team_abbr: 'MTL', n: 2 },
    ];
    myDayRows = [];
  });

  it('tous les matchs en 1 requête, triés par heure, mes votes si connecté', async () => {
    const later = Date.now() + 5 * 3600_000, sooner = Date.now() + 2 * 3600_000;
    dayImpl = async () => [sched('2026020201', 'MTL', 'TOR', later), sched('2026020200', 'STL', 'VGK', sooner), { id: 'x' }];
    myDayRows = [{ game_id: '2026020201', team_abbr: 'TOR' }];
    const { getPickemDay } = await load();
    const d = await getPickemDay('u1');
    expect(d.games.map((g) => g.gameId)).toEqual(['2026020200', '2026020201']);
    expect(d.games[0]).toMatchObject({ total: 12, enough: true, myVote: null, locked: false });
    expect(d.games[0].away.pct).toBe(75);
    expect(d.games[1]).toMatchObject({ total: 2, enough: false, myVote: 'TOR' });
    expect(queries.map((q) => q.sql)).toEqual(['SELECT game_id,', 'SELECT game_id,']);
  });

  it('anonyme : pas de lecture des votes personnels ; totaux en cache, vidés par un vote', async () => {
    dayImpl = async () => [sched('2026020200', 'STL', 'VGK', Date.now() + 2 * 3600_000)];
    gameImpl = async () => nhlGame();
    const { getPickemDay, castPickem } = await load();
    await getPickemDay();
    await getPickemDay();
    expect(queries.filter((q) => q.sql === 'SELECT game_id,')).toHaveLength(1);
    await castPickem('u1', '2026020123', 'VGK');
    queries.length = 0;
    await getPickemDay();
    expect(queries.filter((q) => q.sql === 'SELECT game_id,')).toHaveLength(1);
  });

  it('match fini : gagnant et vote fermé', async () => {
    dayImpl = async () => [sched('2026020200', 'STL', 'VGK', Date.now() - 3 * 3600_000, {
      status: 'final', homeTeam: { abbreviation: 'STL', score: 6 }, awayTeam: { abbreviation: 'VGK', score: 2 },
    })];
    const { getPickemDay } = await load();
    const [g] = (await getPickemDay()).games;
    expect(g).toMatchObject({ locked: true, winner: 'STL', homeScore: 6, awayScore: 2 });
  });

  it('pas de match : aucune requête', async () => {
    dayImpl = async () => [];
    const { getPickemDay } = await load();
    expect((await getPickemDay()).games).toEqual([]);
    expect(queries).toEqual([]);
  });

  it('API LNH muette : 503', async () => {
    dayImpl = async () => { throw new Error('timeout'); };
    const { getPickemDay } = await load();
    await expect(getPickemDay()).rejects.toMatchObject({ status: 503 });
  });
});
