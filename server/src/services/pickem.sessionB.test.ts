import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Session B. Ce qui compte :
 *   • règlement seulement sur un match FINAL, idempotent (`correct IS NULL`) ;
 *   • choix du modèle figé AVANT la mise au jeu, jamais après ;
 *   • classement : votes réglés de la semaine ET, modèle sur les mêmes matchs.
 */

const queries: Array<{ sql: string; params: unknown[] }> = [];
let handler: (sql: string, params: unknown[]) => any = () => ({ rows: [], rowCount: 0 });
vi.mock('../db/connection', () => ({
  pool: { query: async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return handler(sql, params); } },
}));

let games: Record<string, any> = {};
let schedule: any[] = [];
const pushed: Array<{ userIds: string[]; payload: any; opts: any }> = [];
vi.mock('./push.service', () => ({
  sendToUsers: async (userIds: string[], payload: any, opts: any) => { pushed.push({ userIds, payload, opts }); return { sent: userIds.length, failed: 0, expired: 0 }; },
}));
vi.mock('./nhlApiClient', () => ({
  fetchGameById: async (id: string) => { const g = games[id]; if (!g) throw new Error('down'); return g; },
  fetchGamesByDate: async () => schedule,
}));

let state: Record<string, string> = {};
let stateWriteOk = true;
vi.mock('./jobLock', () => ({
  getJobState: async (k: string) => state[k] ?? null,
  setJobState: async (k: string, v: string) => { if (stateWriteOk) state[k] = v; return stateWriteOk; },
}));

let bundle: any = {};
vi.mock('./gameMlBundle', () => ({
  getGameMlBundle: async () => bundle,
  mlBundleKey: (m: string, _l: unknown, _s: unknown, home: boolean) => `${m}|${home}`,
}));

const NOW = Date.parse('2026-10-24T22:30:00Z');           // samedi 18 h 30 ET
const game = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: 'scheduled', startTimeUTC: new Date(NOW + 45 * 60_000).toISOString(),
  homeTeam: { abbreviation: 'STL', score: null }, awayTeam: { abbreviation: 'VGK', score: null }, ...over,
});

async function load() {
  const m = await import('./pickem.service');
  m.clearPickemCache();
  return m;
}

beforeEach(() => {
  queries.length = 0;
  handler = () => ({ rows: [], rowCount: 0 });
  games = {};
  schedule = [];
  pushed.length = 0;
  state = {};
  stateWriteOk = true;
  bundle = { live: null, byKey: { 'moneyline|true': { probability: 38.4 } } };
});

describe('settlePendingPickems', () => {
  it('match final : votes et modèle réglés sur le gagnant ; match pas fini : rien', async () => {
    games = {
      '2026020300': game('2026020300', { status: 'final', homeTeam: { abbreviation: 'STL', score: 6 }, awayTeam: { abbreviation: 'VGK', score: 2 } }),
      '2026020301': game('2026020301', { status: 'live' }),
    };
    handler = (sql) => sql.includes('SELECT DISTINCT game_id') ? { rows: [{ game_id: '2026020300' }, { game_id: '2026020301' }] }
      : sql.startsWith('UPDATE pickem_votes') ? { rowCount: 12 } : { rows: [], rowCount: 1 };
    const { settlePendingPickems } = await load();
    expect(await settlePendingPickems(NOW)).toEqual({ games: 1, votes: 12 });
    const ups = queries.filter((q) => q.sql.startsWith('UPDATE'));
    expect(ups.map((q) => [q.sql.split(' ')[1], q.params])).toEqual([
      ['pickem_votes', ['2026020300', 'STL']], ['pickem_model', ['2026020300', 'STL']],
    ]);
    expect(ups.every((q) => q.sql.includes('correct IS NULL'))).toBe(true);
    // Seulement les matchs commencés depuis plus de 2 h 30.
    expect(queries[0].params).toEqual([new Date(NOW - 2.5 * 3600_000).toISOString()]);
  });

  it('API LNH muette : rien réglé, pas d’erreur', async () => {
    handler = (sql) => sql.includes('SELECT DISTINCT') ? { rows: [{ game_id: '2026020399' }] } : { rows: [] };
    const { settlePendingPickems } = await load();
    expect(await settlePendingPickems(NOW)).toEqual({ games: 0, votes: 0 });
  });
});

describe('snapshotModelPicks', () => {
  it('match voté dans l’heure : choix du modèle figé (visiteur à 61,6 %)', async () => {
    games = { '2026020300': game('2026020300') };
    handler = (sql) => sql.includes('SELECT DISTINCT game_id') ? { rows: [{ game_id: '2026020300' }] } : { rows: [], rowCount: 1 };
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { snapshotModelPicks } = await load();
    expect(await snapshotModelPicks(NOW)).toBe(1);
    const ins = queries.find((q) => q.sql.includes('INSERT INTO pickem_model'))!;
    expect(ins.params).toEqual(['2026020300', 'STL', 'VGK', new Date(NOW + 45 * 60_000).toISOString(), '38.40', 'VGK']);
    expect(ins.sql).toContain('WHERE pickem_model.correct IS NULL');
    vi.restoreAllMocks();
  });

  it('match commencé ou paquet en direct : rien figé', async () => {
    games = { '2026020300': game('2026020300', { status: 'live' }) };
    handler = (sql) => sql.includes('SELECT DISTINCT game_id') ? { rows: [{ game_id: '2026020300' }] } : { rows: [] };
    const { snapshotModelPicks } = await load();
    expect(await snapshotModelPicks(NOW)).toBe(0);
    games = { '2026020300': game('2026020300') };
    bundle = { live: { label: '1re' }, byKey: {} };
    expect(await snapshotModelPicks(NOW)).toBe(0);
    expect(queries.some((q) => q.sql.includes('INSERT INTO pickem_model'))).toBe(false);
  });

  it('aucun match voté dans l’heure : une seule requête, pas de calcul ML', async () => {
    const { snapshotModelPicks } = await load();
    expect(await snapshotModelPicks(NOW)).toBe(0);
    expect(queries).toHaveLength(1);
  });
});

describe('getPickemLeaderboard', () => {
  const users = [
    { userId: 'u1', username: 'ireina', displayName: 'Ireina', avatar: null, avatarUrl: null, picks: 18, wins: 14 },
    { userId: 'u2', username: 'mari', displayName: null, avatar: null, avatarUrl: null, picks: 6, wins: 5 },
  ];
  beforeEach(() => {
    handler = (sql) => sql.includes('FROM pickem_model') ? { rows: [{ games: 23, wins: 14 }] }
      : sql.includes('WITH t AS') ? { rows: [{ games: 22, wins: 13 }] }
      : { rows: users };
  });

  it('semaine en cours, classés ≥ 10 picks, ma ligne même non classée, modèle et public', async () => {
    const { getPickemLeaderboard } = await load();
    const b = await getPickemLeaderboard(0, 'u2', NOW);
    expect(b).toMatchObject({ weekStart: '2026-10-19', weekEnd: '2026-10-25', minPicks: 10, rankedCount: 1 });
    expect(b.ranked.map((r) => [r.username, r.rank, r.pct])).toEqual([['ireina', 1, 78]]);
    expect(b.me).toEqual({ rank: null, picks: 6, wins: 5, pct: 83 });
    expect(b.model).toEqual({ games: 23, wins: 14, pct: 61 });
    expect(b.crowd).toEqual({ games: 22, wins: 13, pct: 59 });
    // Bornes de la semaine en UTC (lundi 19 oct. 00:00 ET → lundi 26 oct. 00:00 ET).
    expect(queries[0].params).toEqual(['2026-10-19T04:00:00.000Z', '2026-10-26T04:00:00.000Z']);
  });

  it('cache 5 min : 2e lecture sans requête ; anonyme : pas de ligne perso', async () => {
    const { getPickemLeaderboard } = await load();
    await getPickemLeaderboard(0, undefined, NOW);
    const n = queries.length;
    const b = await getPickemLeaderboard(0, undefined, NOW);
    expect(queries.length).toBe(n);
    expect(b.me).toBeNull();
  });
});

describe('remindPickemLock (session C)', () => {
  const FIRST = Date.parse('2026-10-24T23:00:00Z');
  const sched = (id: string, startMs: number) => ({
    id, startTimeUTC: new Date(startMs).toISOString(), status: 'scheduled',
    homeTeam: { abbreviation: 'STL' }, awayTeam: { abbreviation: 'VGK' },
  });
  beforeEach(() => {
    schedule = [sched('2026020301', FIRST + 3600_000), sched('2026020300', FIRST)];
    handler = (sql) => sql.includes('apns_device_tokens') ? { rows: [{ userId: 'u1' }, { userId: 'u2' }] } : { rows: [] };
  });

  it('1 h avant le 1er match : iPhone seulement, jour marqué, une seule fois', async () => {
    const { remindPickemLock } = await load();
    expect(await remindPickemLock(FIRST - 60 * 60_000)).toBe(2);
    expect(state['pickem-reminder-day']).toBe('2026-10-24');
    expect(pushed).toHaveLength(1);
    expect(pushed[0].userIds).toEqual(['u1', 'u2']);
    expect(pushed[0].opts).toEqual({ channels: ['apns'] });
    expect(pushed[0].payload.fr.body).toContain('VGK @ STL ouvre la soirée (2 matchs)');
    // Les matchs du jour sont exclus pour ceux qui ont déjà voté.
    const q = queries.find((x) => x.sql.includes('apns_device_tokens'))!;
    expect(q.params[1]).toEqual(['2026020300', '2026020301']);
    expect(await remindPickemLock(FIRST - 45 * 60_000)).toBe(0);
    expect(pushed).toHaveLength(1);
  });

  it('hors fenêtre : aucune requête en base', async () => {
    const { remindPickemLock } = await load();
    expect(await remindPickemLock(FIRST - 3 * 3600_000)).toBe(0);
    expect(queries).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it('mémoire impossible à écrire : rien n’est envoyé (pas de doublon possible)', async () => {
    stateWriteOk = false;
    const { remindPickemLock } = await load();
    expect(await remindPickemLock(FIRST - 60 * 60_000)).toBe(0);
    expect(pushed).toEqual([]);
  });

  it('personne à prévenir : marqué quand même, aucun envoi', async () => {
    handler = () => ({ rows: [] });
    const { remindPickemLock } = await load();
    expect(await remindPickemLock(FIRST - 60 * 60_000)).toBe(0);
    expect(state['pickem-reminder-day']).toBe('2026-10-24');
    expect(pushed).toEqual([]);
  });
});
