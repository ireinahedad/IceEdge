/**
 * nhlApiClient.ts
 * Fetches real-time data from the official NHL Stats API (api-web.nhle.com/v1).
 * Results are cached in memory with per-endpoint TTLs.
 */

const BASE = 'https://api-web.nhle.com/';

// --- Simple in-memory TTL cache -------------------------------------------

interface CacheEntry { data: unknown; expiresAt: number }
const _cache = new Map<string, CacheEntry>();

function getCached<T>(key: string): T | null {
  const e = _cache.get(key);
  return e && Date.now() < e.expiresAt ? (e.data as T) : null;
}
function setCached(key: string, data: unknown, ttlMs: number) {
  _cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// --- HTTP helper (native fetch, Node 18+) ---------------------------------

async function fetchNHL<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'IceEdge/1.0 (nhle-stats-client)',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw Object.assign(
      new Error(`NHL API ${res.status} for ${path}`),
      { status: res.status }
    );
  }
  return res.json() as Promise<T>;
}

// --- Team emoji / colour metadata (not in the NHL API) --------------------

const TEAM_META: Record<string, { emoji: string; color: string }> = {
  ANA: { emoji: '🦆', color: '#F47A38' },
  BOS: { emoji: '🐻', color: '#FFB81C' },
  BUF: { emoji: '🦬', color: '#003087' },
  CGY: { emoji: '🔥', color: '#C8102E' },
  CAR: { emoji: '🌀', color: '#CC0000' },
  CHI: { emoji: '🦅', color: '#CF0A2C' },
  COL: { emoji: '🏔️', color: '#6F263D' },
  CBJ: { emoji: '🎖️', color: '#002654' },
  DAL: { emoji: '⭐', color: '#006847' },
  DET: { emoji: '🐙', color: '#CE1126' },
  EDM: { emoji: '🛢️', color: '#FF4C00' },
  FLA: { emoji: '🐆', color: '#041E42' },
  LAK: { emoji: '👑', color: '#111111' },
  MIN: { emoji: '🌲', color: '#154734' },
  MTL: { emoji: '🔴', color: '#AF1E2D' },
  NSH: { emoji: '🎸', color: '#FFB81C' },
  NJD: { emoji: '👹', color: '#CE1126' },
  NYI: { emoji: '🏝️', color: '#00539B' },
  NYR: { emoji: '🗽', color: '#0038A8' },
  OTT: { emoji: '🏛️', color: '#C52032' },
  PHI: { emoji: '🔔', color: '#F74902' },
  PIT: { emoji: '🐧', color: '#FCB514' },
  SEA: { emoji: '🐙', color: '#001628' },
  SJS: { emoji: '🦈', color: '#006D75' },
  STL: { emoji: '🎵', color: '#002F87' },
  TBL: { emoji: '⚡', color: '#002868' },
  TOR: { emoji: '🍁', color: '#003E7E' },
  UTA: { emoji: '⚔️', color: '#69B3E7' },
  VAN: { emoji: '🐋', color: '#00205B' },
  VGK: { emoji: '🃏', color: '#B4975A' },
  WPG: { emoji: '✈️', color: '#041E42' },
  WSH: { emoji: '🦅', color: '#CF0A2C' },
};

// --- Current season helper ------------------------------------------------

function currentSeason(): string {
  const now  = new Date();
  const year = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}${year + 1}`;
}

// --- Teams / Standings ----------------------------------------------------

export async function fetchTeams(): Promise<any[]> {
  const cached = getCached<any[]>('teams');
  if (cached) return cached;

  const data = await fetchNHL<any>('v1/standings/now');
  const teams = (data.standings ?? []).map((s: any) => {
    const abbr: string = s.teamAbbrev?.default ?? '';
    const meta = TEAM_META[abbr] ?? { emoji: '🏒', color: '#86d1ea' };
    const gp   = s.gamesPlayed || 1;
    return {
      id:           abbr,
      name:         s.teamFullName?.default ?? s.teamName?.default ?? abbr,
      abbreviation: abbr,
      city:         s.placeName?.default ?? '',
      conference:   s.conferenceName ?? '',
      division:     s.divisionName   ?? '',
      emoji:        meta.emoji,
      color:        meta.color,
      gamesPlayed:  gp,
      wins:         s.wins     ?? 0,
      losses:       s.losses   ?? 0,
      otLosses:     s.otLosses ?? 0,
      points:       s.points   ?? 0,
      winPct:       Math.round((s.winPctg ?? 0) * 100),
      homeRecord:   `${s.homeWins ?? 0}-${s.homeLosses ?? 0}-${s.homeOtLosses ?? 0}`,
      awayRecord:   `${s.roadWins ?? 0}-${s.roadLosses ?? 0}-${s.roadOtLosses ?? 0}`,
      streak:       s.streakCode && s.streakCount ? `${s.streakCode}${s.streakCount}` : '',
      goalsFor:            s.goalFor     ?? 0,
      goalsAgainst:        s.goalAgainst ?? 0,
      goalsForPerGame:     +((s.goalFor     ?? 0) / gp).toFixed(2),
      goalsAgainstPerGame: +((s.goalAgainst ?? 0) / gp).toFixed(2),
      ppPct: s.powerPlayPctg   != null ? Math.round(s.powerPlayPctg   * 1000) / 10 : 0,
      pkPct: s.penaltyKillPctg != null ? Math.round(s.penaltyKillPctg * 1000) / 10 : 0,
    };
  });

  setCached('teams', teams, 5 * 60_000);
  return teams;
}

export async function fetchTeamByAbbr(abbr: string): Promise<any> {
  const all  = await fetchTeams();
  const team = all.find(t => t.abbreviation.toLowerCase() === abbr.toLowerCase());
  if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
  return team;
}

// --- Games ----------------------------------------------------------------

function parseGameState(state: string): string {
  const MAP: Record<string, string> = {
    FUT: 'scheduled', PRE: 'scheduled',
    LIVE: 'live',     CRIT: 'live',
    FINAL: 'final',   OVER: 'final', OFF: 'final',
  };
  return MAP[state] ?? state?.toLowerCase() ?? 'scheduled';
}

function formatGame(g: any, date?: string): any {
  const homeAbbr = g.homeTeam?.abbrev ?? '';
  const awayAbbr = g.awayTeam?.abbrev ?? '';
  const homeMeta = TEAM_META[homeAbbr] ?? { emoji: '🏒', color: '#86d1ea' };
  const awayMeta = TEAM_META[awayAbbr] ?? { emoji: '🏒', color: '#86d1ea' };

  let startTime = '';
  if (g.startTimeUTC) {
    startTime = new Date(g.startTimeUTC).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit',
      timeZone: 'America/New_York', hour12: true,
    }) + ' ET';
  }

  const gameDate = date ?? g.gameDate ?? g.startTimeUTC?.slice(0, 10) ?? '';

  return {
    id:          String(g.id),
    gameDate,
    startTime,
    status:      parseGameState(g.gameState ?? ''),
    period:      g.periodDescriptor?.number ?? null,
    clock:       g.clock?.timeRemaining ?? null,
    venue:       g.venue?.default ?? '',
    gameType:    g.gameType === 3 ? 'playoff' : 'regular',
    overUnder:   null,
    homeWinPct:  50,
    awayWinPct:  50,
    homeTeam: {
      id:           homeAbbr,
      abbreviation: homeAbbr,
      name:         g.homeTeam?.commonName?.default ?? g.homeTeam?.name?.default ?? homeAbbr,
      emoji:        homeMeta.emoji,
      score:        g.homeTeam?.score ?? null,
      odds:         null,
    },
    awayTeam: {
      id:           awayAbbr,
      abbreviation: awayAbbr,
      name:         g.awayTeam?.commonName?.default ?? g.awayTeam?.name?.default ?? awayAbbr,
      emoji:        awayMeta.emoji,
      score:        g.awayTeam?.score ?? null,
      odds:         null,
    },
  };
}

export async function fetchGamesByDate(date: string): Promise<any[]> {
  const key    = `schedule:${date}`;
  const cached = getCached<any[]>(key);
  if (cached) return cached;

  const data     = await fetchNHL<any>(`v1/schedule/${date}`);
  const dayEntry = (data.gameWeek ?? []).find((w: any) => w.date === date);
  if (!dayEntry?.games?.length) return [];

  const games = dayEntry.games.map((g: any) => formatGame(g, date));
  const ttl   = games.some((g: any) => g.status === 'live') ? 30_000 : 5 * 60_000;
  setCached(key, games, ttl);
  
  return games;
}

export async function fetchLiveGames(): Promise<any[]> {
  const cached = getCached<any[]>('live');
  if (cached) return cached;

  const data  = await fetchNHL<any>('v1/scoreboard/now');
  const games = (data.games ?? [])
    .filter((g: any) => g.gameState === 'LIVE' || g.gameState === 'CRIT')
    .map((g: any) => formatGame(g));

  setCached('live', games, 30_000);
  return games;
}

export async function fetchGameById(gameId: string): Promise<any> {
  try {
    const data = await fetchNHL<any>(`v1/gamecenter/${gameId}/landing`);
    return formatGame(data);
  } catch {
    throw Object.assign(new Error('Game not found'), { status: 404 });
  }
}

// --- Players --------------------------------------------------------------

export async function fetchTopPlayers(): Promise<any[]> {
  const cached = getCached<any[]>('players');
  if (cached) return cached;

  const season = currentSeason();

  const [pointsRes, goalsRes] = await Promise.all([
    fetchNHL<any>(`v1/skater-stats-leaders/${season}/2?categories=points&limit=50`),
    fetchNHL<any>(`v1/skater-stats-leaders/${season}/2?categories=goals&limit=25`),
  ]);

  const map = new Map<number, any>();

  function merge(p: any) {
    const pts = p.points ?? p.value ?? 0;
    const gp  = p.gamesPlayed ?? 1;
    const entry = {
      id:          String(p.id),
      name:        [p.firstName?.default, p.lastName?.default].filter(Boolean).join(' '),
      teamId:      (p.teamAbbreviation ?? '').toLowerCase(),
      position:    p.positionCode ?? 'F',
      number:      p.sweaterNumber ?? 0,
      goals:       p.goals   ?? 0,
      assists:     p.assists ?? 0,
      points:      pts,
      plusMinus:   p.plusMinus ?? 0,
      shots:       p.shots    ?? 0,
      shotPct:     p.shootingPctg != null ? Math.round(p.shootingPctg * 1000) / 10 : 0,
      ppPoints:    p.powerPlayPoints ?? 0,
      gamesPlayed: gp,
      lastFive:    [] as number[],
      winImpact:   Math.min(99, Math.round((pts / gp) * 100)),
    };
    const existing = map.get(p.id);
    if (!existing || pts > existing.points) map.set(p.id, entry);
  }

  for (const p of (pointsRes?.points ?? [])) merge(p);
  for (const p of (goalsRes?.goals   ?? [])) merge(p);

  const players = [...map.values()].sort((a, b) => b.points - a.points);
  setCached('players', players, 10 * 60_000);
  return players;
}

export async function fetchPlayerById(playerId: string): Promise<any> {
  const data    = await fetchNHL<any>(`v1/player/${playerId}/landing`);
  const seasons = (data.seasonTotals ?? []).filter(
    (s: any) => s.leagueAbbrev === 'NHL' && s.gameTypeId === 2
  );
  const cur  = seasons[seasons.length - 1] ?? {};
  const abbr = data.currentTeamAbbrev ?? '';
  const pts  = cur.points ?? 0;
  const gp   = cur.gamesPlayed ?? 1;

  return {
    id:          String(data.playerId),
    name:        [data.firstName?.default, data.lastName?.default].filter(Boolean).join(' '),
    teamId:      abbr.toLowerCase(),
    teamAbbr:    abbr,
    position:    data.position ?? 'F',
    number:      data.sweaterNumber ?? 0,
    goals:       cur.goals   ?? 0,
    assists:     cur.assists  ?? 0,
    points:      pts,
    plusMinus:   cur.plusMinus ?? 0,
    shots:       cur.shots     ?? 0,
    shotPct:     cur.shootingPctg != null ? Math.round(cur.shootingPctg * 1000) / 10 : 0,
    ppPoints:    cur.powerPlayPoints ?? 0,
    gamesPlayed: gp,
    lastFive:    [] as number[],
    winImpact:   Math.min(99, Math.round((pts / gp) * 100)),
  };
}

export async function searchPlayers(q: string): Promise<any[]> {
  if (!q.trim()) return [];
  try {
    const data    = await fetchNHL<any>(
      `v1/search/player?culture=en-us&limit=20&q=${encodeURIComponent(q)}&active=true`
    );
    const results: any[] = data.players ?? data ?? [];
    return results.map((p: any) => ({
      id:       String(p.playerId ?? p.id),
      name:     p.name ?? [p.firstName, p.lastName].filter(Boolean).join(' '),
      teamId:   (p.teamAbbreviation ?? p.teamAbbrev ?? '').toLowerCase(),
      position: p.positionCode ?? p.position ?? 'F',
      number:   p.sweaterNumber ?? 0,
      goals: 0, assists: 0, points: 0,
      plusMinus: 0, shots: 0, shotPct: 0, ppPoints: 0,
      gamesPlayed: 0, lastFive: [] as number[], winImpact: 0,
    }));
  } catch {
    const lower = q.toLowerCase();
    const all   = await fetchTopPlayers();
    return all.filter(p =>
      p.name.toLowerCase().includes(lower) || p.teamId.includes(lower)
    );
  }
}

/** Fetch the full roster for a team (abbr like "EDM") with current-season stats */
export async function fetchTeamRoster(abbr: string): Promise<any[]> {
  const upper = abbr.toUpperCase();
  const cacheKey = `roster_${upper}`;
  const cached = getCached<any[]>(cacheKey);
  if (cached) return cached;

  const season = currentSeason();

  // Roster list
  const rosterData = await fetchNHL<any>(`v1/roster/${upper}/${season}`);
  const allPlayers: any[] = [
    ...(rosterData.forwards  ?? []),
    ...(rosterData.defensemen ?? []),
    ...(rosterData.goalies   ?? []),
  ];

  // Fetch stats for every player in parallel (capped to avoid hammering API)
  const statsResults = await Promise.allSettled(
    allPlayers.map(p => fetchNHL<any>(`v1/player/${p.id}/landing`))
  );

  const out: any[] = [];
  for (let i = 0; i < allPlayers.length; i++) {
    const roster = allPlayers[i];
    const res    = statsResults[i];
    if (res.status === 'rejected') continue;
    const data   = res.value as any;
    const seasons = (data.seasonTotals ?? []).filter(
      (s: any) => s.leagueAbbrev === 'NHL' && s.gameTypeId === 2
    );
    const cur  = seasons[seasons.length - 1] ?? {};
    const pts  = cur.points ?? 0;
    const gp   = Math.max(cur.gamesPlayed ?? 1, 1);
    out.push({
      id:          String(roster.id),
      name:        [roster.firstName?.default, roster.lastName?.default].filter(Boolean).join(' '),
      teamId:      upper.toLowerCase(),
      teamAbbr:    upper,
      position:    roster.positionCode ?? 'F',
      number:      roster.sweaterNumber ?? 0,
      goals:       cur.goals    ?? 0,
      assists:     cur.assists  ?? 0,
      points:      pts,
      plusMinus:   cur.plusMinus ?? 0,
      shots:       cur.shots    ?? 0,
      shotPct:     cur.shootingPctg != null ? Math.round(cur.shootingPctg * 1000) / 10 : 0,
      ppPoints:    cur.powerPlayPoints ?? 0,
      gamesPlayed: gp,
      lastFive:    [] as number[],
      winImpact:   Math.min(99, Math.round((pts / gp) * 100)),
    });
  }

  out.sort((a, b) => b.points - a.points);
  setCached(cacheKey, out, 30 * 60_000); // cache 30 min
  return out;
}
