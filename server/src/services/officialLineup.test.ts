import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Alignement officiel — ce qui compte comme « publié ».
 *
 * Observé en direct le 2026-10-01 : ~2 h avant le match, `rosterSpots` porte
 * l'EFFECTIF (23 par équipe) ; peu avant la mise au jeu il tombe aux 20
 * habillés et `right-rail` publie les absents. Prendre l'effectif de 23 pour
 * l'alignement ferait passer les absents du soir pour habillés.
 */

const responses: Record<string, unknown> = {};
const calls: string[] = [];
vi.mock('./nhl/core', async (orig) => ({
  ...(await orig<typeof import('./nhl/core')>()),
  USE_MOCK: false,
  fetchNHL: vi.fn(async (path: string) => {
    calls.push(path);
    if (!(path in responses)) throw new Error(`404 ${path}`);
    return responses[path];
  }),
}));
vi.mock('./startingGoalies', () => ({ easternToday: () => '2026-10-10' }));

const HOME = 10, AWAY = 8;
const spot = (teamId: number, i: number, pos = 'C') => ({
  teamId, playerId: teamId * 1000 + i, positionCode: pos,
  firstName: { default: `P${i}` }, lastName: { default: `T${teamId}` },
});
const roster = (teamId: number, n: number) =>
  Array.from({ length: n }, (_, i) => spot(teamId, i, i < 2 ? 'G' : 'C'));
const pbp = (nHome: number, nAway: number) => ({
  homeTeam: { id: HOME }, awayTeam: { id: AWAY },
  rosterSpots: [...roster(HOME, nHome), ...roster(AWAY, nAway)],
});
// Forme réelle d'un absent dans `right-rail` : `id`, pas `playerId`.
const scratch = (teamId: number, i: number) => ({
  id: teamId * 1000 + i, firstName: { default: `P${i}` }, lastName: { default: `T${teamId}` },
});
const rail = (homeScratches: number, awayScratches: number) => ({
  gameInfo: {
    homeTeam: { scratches: Array.from({ length: homeScratches }, (_, i) => scratch(HOME, 50 + i)) },
    awayTeam: { scratches: Array.from({ length: awayScratches }, (_, i) => scratch(AWAY, 50 + i)) },
  },
});

let gid = 2026020500;
beforeEach(() => {
  for (const k of Object.keys(responses)) delete responses[k];
  calls.length = 0;
  gid += 1;          // un identifiant neuf par test : le cache du module ne déborde pas
});

describe('fetchGameLineup', () => {
  it('effectif de 23 sans absents publiés : PAS confirmé', async () => {
    responses[`v1/gamecenter/${gid}/play-by-play`] = pbp(23, 23);
    responses[`v1/gamecenter/${gid}/right-rail`] = rail(0, 0);
    const { fetchGameLineup } = await import('./officialLineup');
    const l = await fetchGameLineup(gid, 'FUT', 'TOR', 'MTL');
    expect(l!.home.confirmed).toBe(false);
    expect(l!.away.confirmed).toBe(false);
  });

  it('absents publiés par morceaux (21 habillés + 2 absents) : absents gardés, PAS confirmé', async () => {
    // Vu sur CGY pendant 20 minutes avant que l'alignement tombe à 20.
    responses[`v1/gamecenter/${gid}/play-by-play`] = pbp(21, 23);
    responses[`v1/gamecenter/${gid}/right-rail`] = rail(2, 0);
    const { fetchGameLineup } = await import('./officialLineup');
    const l = await fetchGameLineup(gid, 'PRE', 'TOR', 'MTL');
    expect(l!.home.confirmed).toBe(false);
    expect(l!.home.scratches).toHaveLength(2);
  });

  it('20 habillés + absents publiés : confirmé, avec les noms complets', async () => {
    responses[`v1/gamecenter/${gid}/play-by-play`] = pbp(20, 20);
    responses[`v1/gamecenter/${gid}/right-rail`] = rail(3, 2);
    const { fetchGameLineup } = await import('./officialLineup');
    const l = await fetchGameLineup(gid, 'PRE', 'TOR', 'MTL');
    expect(l!.home).toMatchObject({ abbr: 'TOR', confirmed: true });
    expect(l!.home.dressed).toHaveLength(20);
    expect(l!.home.scratches.map((p) => p.name)).toEqual(['P50 T10', 'P51 T10', 'P52 T10']);
    expect(l!.home.scratches[0].id).toBe(HOME * 1000 + 50);
    expect(l!.away.dressed[0]).toEqual({ id: AWAY * 1000, name: 'P0 T8', pos: 'G' });
  });

  it('match commencé : feuille de match (boxscore), toujours confirmé', async () => {
    const side = (teamId: number) => ({
      forwards: Array.from({ length: 12 }, (_, i) => ({ playerId: teamId * 1000 + i, name: { default: 'A. Player' }, position: 'C' })),
      defense: Array.from({ length: 6 }, (_, i) => ({ playerId: teamId * 1000 + 20 + i, name: { default: 'B. Player' }, position: 'D' })),
      goalies: [{ playerId: teamId * 1000 + 30, name: { default: 'G. Keeper' }, position: 'G' }],
    });
    responses[`v1/gamecenter/${gid}/boxscore`] = {
      homeTeam: { id: HOME }, awayTeam: { id: AWAY },
      playerByGameStats: { homeTeam: side(HOME), awayTeam: side(AWAY) },
    };
    const { fetchGameLineup } = await import('./officialLineup');
    const l = await fetchGameLineup(gid, 'LIVE', 'TOR', 'MTL');
    expect(l!.home.confirmed).toBe(true);
    expect(l!.home.dressed).toHaveLength(19);
    expect(calls.some((c) => c.endsWith('/play-by-play'))).toBe(false);
  });

  it('API en panne : null, sans lever', async () => {
    const { fetchGameLineup } = await import('./officialLineup');
    expect(await fetchGameLineup(gid, 'FUT', 'TOR', 'MTL')).toBeNull();
  });
});

describe('getOfficialLineupsDay', () => {
  it('garde les équipes confirmées ou avec des absents publiés, rien pour un match lointain', async () => {
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    const late = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
    responses['v1/schedule/2026-10-10'] = { gameWeek: [{ date: '2026-10-10', games: [
      { id: gid, gameState: 'PRE', startTimeUTC: soon, homeTeam: { abbrev: 'TOR' }, awayTeam: { abbrev: 'MTL' } },
      { id: gid + 1, gameState: 'FUT', startTimeUTC: late, homeTeam: { abbrev: 'BOS' }, awayTeam: { abbrev: 'NYR' } },
    ] }] };
    responses[`v1/gamecenter/${gid}/play-by-play`] = pbp(20, 23);
    responses[`v1/gamecenter/${gid}/right-rail`] = rail(2, 0);
    const { getOfficialLineupsDay } = await import('./officialLineup');
    const day = await getOfficialLineupsDay('2026-10-10');
    // MTL : effectif de 23, aucun absent publié → rien.
    expect(Object.keys(day)).toEqual(['TOR']);
    expect(day.TOR.confirmed).toBe(true);
    expect(calls.some((c) => c.includes(String(gid + 1)))).toBe(false);
  });
});

describe('isDressed', () => {
  it('nom complet, accents et initiale de la feuille de match', async () => {
    const { isDressed } = await import('./officialLineup');
    const l = { gameId: 1, abbr: 'MTL', confirmed: true, scratches: [],
                dressed: [{ id: 1, name: 'Juraj Slafkovský', pos: 'L' }, { id: 2, name: 'N. Suzuki', pos: 'C' }] };
    expect(isDressed(l, 'Juraj Slafkovsky')).toBe(true);
    expect(isDressed(l, 'Nick Suzuki')).toBe(true);
    expect(isDressed(l, 'Cole Caufield')).toBe(false);
    expect(isDressed(undefined, 'Nick Suzuki')).toBe(false);
    // Alignement pas encore définitif : personne n'est « habillé ».
    expect(isDressed({ ...l, confirmed: false }, 'Nick Suzuki')).toBe(false);
  });
});
