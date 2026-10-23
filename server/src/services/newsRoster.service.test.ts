import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * F4 — tour quotidien des effectifs. Ce qui compte :
 *   • rien avant midi ET, une seule fois par jour, rien si une autre instance l'a fait ;
 *   • nouvelles + veilles dans UNE transaction ; échec → veilles intactes ;
 *   • une équipe illisible garde sa veille (pas de faux « retiré »).
 */

const roster = (ids: number[]) => ({
  forwards: ids.map((id) => ({ id, firstName: { default: 'P' }, lastName: { default: String(id) }, positionCode: 'C', sweaterNumber: id % 99 })),
});

let rosters: Record<string, number[] | 'fail'> = {};
let prevRows: Array<{ key: string; value: string }> = [];
let dayMarker: string | null = null;
let insertFails = false;
const sql: string[] = [];
const params: unknown[][] = [];

const client = {
  query: vi.fn(async (q: string, p?: unknown[]) => {
    sql.push(q.trim().split(/\s+/).slice(0, 3).join(' '));
    params.push(p ?? []);
    if (q.includes('INSERT INTO news_items')) {
      if (insertFails) throw new Error('violates check constraint "news_items_source_check"');
      const n = (p!.length - 1) / 5;
      return { rows: Array.from({ length: n }, (_, i) => ({ id: i + 1 })), rowCount: n };
    }
    return { rows: [], rowCount: 0 };
  }),
  release: vi.fn(),
};

vi.mock('../db/connection', () => ({
  pool: {
    query: vi.fn(async () => ({ rows: prevRows })),
    connect: vi.fn(async () => client),
  },
}));
vi.mock('./jobLock', () => ({ getJobState: vi.fn(async () => dayMarker) }));
vi.mock('./nhl/core', () => ({
  USE_MOCK: false,
  TEAM_META: { TOR: {}, VGK: {}, MTL: {} },
  fetchNHL: vi.fn(async (path: string) => {
    const team = /roster\/([A-Z]+)\/current/.exec(path)![1];
    const r = rosters[team];
    if (r === 'fail' || !r) throw new Error('NHL API 503');
    return roster(r);
  }),
}));

const NOON_ET = Date.parse('2026-10-23T16:05:00Z');
const MORNING_ET = Date.parse('2026-10-23T14:00:00Z');

async function load() {
  const mod = await import('./newsRoster.service');
  mod.resetRosterMemory();
  const core = await import('./nhl/core');
  return { ...mod, fetchNHL: core.fetchNHL as unknown as ReturnType<typeof vi.fn> };
}

const state = (team: string, ids: number[]) => ({
  key: `news-roster:${team}`,
  value: JSON.stringify(ids.map((id) => ({ id, name: `P ${id}`, pos: 'C', num: id % 99 }))),
});

describe('runRosterDiffIfDue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sql.length = 0; params.length = 0;
    rosters = { TOR: [1, 93], VGK: [5], MTL: [7] };
    prevRows = [];
    dayMarker = null;
    insertFails = false;
  });

  it('avant midi ET : aucun appel', async () => {
    const { runRosterDiffIfDue, fetchNHL } = await load();
    expect(await runRosterDiffIfDue(MORNING_ET)).toEqual({ ran: false });
    expect(fetchNHL).not.toHaveBeenCalled();
  });

  it('déjà fait aujourd’hui par une autre instance : aucun appel LNH', async () => {
    dayMarker = '2026-10-23';
    const { runRosterDiffIfDue, fetchNHL } = await load();
    expect(await runRosterDiffIfDue(NOON_ET)).toEqual({ ran: false });
    expect(fetchNHL).not.toHaveBeenCalled();
  });

  it('1er tour : base enregistrée, aucune nouvelle', async () => {
    const { runRosterDiffIfDue } = await load();
    const out = await runRosterDiffIfDue(NOON_ET);
    expect(out).toMatchObject({ ran: true, teamsRead: 3, events: 0, inserted: 0, baseline: 3 });
    expect(sql).toEqual(['BEGIN', 'INSERT INTO job_state', 'COMMIT']);
    const [keys] = params[1] as [string[]];
    expect(keys).toEqual(['news-roster:day', 'news-roster:MTL', 'news-roster:TOR', 'news-roster:VGK']);
  });

  it('échange TOR → VGK : une nouvelle, puis veilles, dans une transaction ; une seule fois par jour', async () => {
    prevRows = [state('TOR', [1, 93]), state('VGK', [5]), state('MTL', [7])];
    rosters = { TOR: [1], VGK: [5, 93], MTL: [7] };
    const { runRosterDiffIfDue, fetchNHL } = await load();

    const out = await runRosterDiffIfDue(NOON_ET);
    expect(out).toMatchObject({ ran: true, events: 1, inserted: 1 });
    expect(sql).toEqual(['BEGIN', 'INSERT INTO news_items', 'INSERT INTO job_state', 'COMMIT']);
    const p = params[1];
    expect(p.slice(0, 5)).toEqual([
      '2026-10-23:moved:93:VGK-TOR', ['VGK', 'TOR'], 'NHL.com',
      'https://www.nhl.com/player/93', 'Roster move: P 93 (C, #93) leaves TOR for VGK.',
    ]);
    expect(fetchNHL).toHaveBeenCalledTimes(3);

    // 2e tour le même jour : rien.
    expect(await runRosterDiffIfDue(NOON_ET + 15 * 60_000)).toEqual({ ran: false });
    expect(fetchNHL).toHaveBeenCalledTimes(3);
  });

  it('INSERT refusé (migration 048 absente) : ROLLBACK, veilles intactes, pas de relance le même jour', async () => {
    prevRows = [state('TOR', [1, 93]), state('VGK', [5]), state('MTL', [7])];
    rosters = { TOR: [1], VGK: [5, 93], MTL: [7] };
    insertFails = true;
    const { runRosterDiffIfDue, fetchNHL } = await load();

    expect(await runRosterDiffIfDue(NOON_ET)).toEqual({ ran: true, inserted: 0 });
    expect(sql).toEqual(['BEGIN', 'INSERT INTO news_items', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalled();

    expect(await runRosterDiffIfDue(NOON_ET + 15 * 60_000)).toEqual({ ran: false });
    expect(fetchNHL).toHaveBeenCalledTimes(3);
  });

  it('équipe illisible : pas comparée, sa veille n’est pas réécrite', async () => {
    prevRows = [state('TOR', [1, 93]), state('VGK', [5]), state('MTL', [7])];
    rosters = { TOR: 'fail', VGK: [5], MTL: [7] };
    const { runRosterDiffIfDue } = await load();
    const out = await runRosterDiffIfDue(NOON_ET);
    expect(out).toMatchObject({ ran: true, teamsRead: 2, events: 0 });
    const [keys] = params[params.length - 2] as [string[]];
    expect(keys).not.toContain('news-roster:TOR');
  });

  it('LNH entièrement muette : rien écrit', async () => {
    rosters = { TOR: 'fail', VGK: 'fail', MTL: 'fail' };
    const { runRosterDiffIfDue } = await load();
    expect(await runRosterDiffIfDue(NOON_ET)).toMatchObject({ ran: true, teamsRead: 0 });
    expect(sql).toEqual([]);
  });
});
