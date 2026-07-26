/**
 * nhlApiClient.ts
 * Fetches real-time data from the official NHL Stats API (api-web.nhle.com/v1).
 * Results are cached in memory with per-endpoint TTLs.
 */

import {
  MOCK_TEAMS_FULL,
  MOCK_GAMES_FULL,
  MOCK_TOP_PLAYERS,
  MOCK_PLAYER_BY_ID,
} from '../data/mockNhl';
import { computeTravel, TravelGame, TravelFeatures } from './travel';

/** When NHL_USE_MOCK=true, serve rich local mock data instead of the live NHL API. */
const USE_MOCK = process.env.NHL_USE_MOCK === 'true';

const BASE = 'https://api-web.nhle.com/';
// The player-search endpoint lives on a separate host from the main stats API.
const SEARCH_BASE = 'https://search.d3.nhle.com/api/';

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

/** Same as fetchNHL, but against the separate player-search host. */
async function fetchNHLSearch<T>(path: string): Promise<T> {
  const url = `${SEARCH_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'IceEdge/1.0 (nhle-stats-client)',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw Object.assign(
      new Error(`NHL Search API ${res.status} for ${path}`),
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

function _splitPct(wins?: number, losses?: number, otLosses?: number): number {
  const gp = (wins ?? 0) + (losses ?? 0) + (otLosses ?? 0);
  return gp > 0 ? +((wins ?? 0) / gp).toFixed(4) : 0.5;
}

export async function fetchTeams(): Promise<any[]> {
  if (USE_MOCK) return MOCK_TEAMS_FULL as any[];
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
      // NOTE: powerPlayPctg/penaltyKillPctg n'existent PAS dans standings —
      // les vrais PP/PK viennent de fetchTeamSummaryStats() (api.nhle.com/stats/rest)
      ppPct: s.powerPlayPctg   != null ? Math.round(s.powerPlayPctg   * 1000) / 10 : 0,
      pkPct: s.penaltyKillPctg != null ? Math.round(s.penaltyKillPctg * 1000) / 10 : 0,
      // Forme récente L10 (ex: "7-2-1") — consommé par parseLastTen()
      last10: `${s.l10Wins ?? 5}-${s.l10Losses ?? 4}-${s.l10OtLosses ?? 1}`,
      // Splits domicile / extérieur (win% simple)
      homeWinPct: _splitPct(s.homeWins, s.homeLosses, s.homeOtLosses),
      roadWinPct: _splitPct(s.roadWins, s.roadLosses, s.roadOtLosses),
      // Série signée : W3 → +3, L2 → -2
      streakSigned: (s.streakCode === 'W' ? 1 : -1) * (s.streakCount ?? 0),
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
    startTimeUTC: g.startTimeUTC ?? null, // raw ISO — used by settlement scheduling
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
  if (USE_MOCK) return MOCK_GAMES_FULL as any[];
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

/**
 * Retourne tous les matchs (joués + à venir) entre deux dates incluses, en
 * parcourant l'endpoint hebdomadaire v1/schedule/{date} semaine par semaine.
 * Utilisé par la page calendrier (schedule) côté client.
 *  - start / end : 'YYYY-MM-DD' (end doit être >= start).
 *  - L'amplitude est bornée à 45 jours pour limiter les appels upstream.
 */
export async function fetchGamesRange(start: string, end: string): Promise<any[]> {
  const addDays = (iso: string, n: number): string => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  // Borne l'amplitude (sécurité : évite les balayages illimités).
  const MAX_SPAN = 45;
  if (addDays(start, MAX_SPAN) < end) end = addDays(start, MAX_SPAN);

  if (USE_MOCK) {
    return (MOCK_GAMES_FULL as any[]).filter(
      (g) => g.gameDate >= start && g.gameDate <= end,
    );
  }

  const key    = `range:${start}:${end}`;
  const cached = getCached<any[]>(key);
  if (cached) return cached;

  const seen = new Set<string>();
  const out: any[] = [];
  let cursor = start;

  // Parcourt la fenêtre semaine par semaine. Ne s'arrête JAMAIS sur une semaine
  // vide (ex. début octobre avant le coup d'envoi) : on avance toujours, sinon
  // on manquerait les matchs situés plus loin dans le mois. Garde-fou large
  // (une itération par jour dans le pire cas) — les appels sont mis en cache.
  for (let guard = 0; guard < MAX_SPAN + 2 && cursor <= end; guard++) {
    let week: any[] = [];
    try {
      const data = await fetchNHL<any>(`v1/schedule/${cursor}`);
      week = data.gameWeek ?? [];
    } catch {
      // Jour sans données exploitables : on avance d'un jour.
    }

    let maxDate = cursor;
    for (const day of week) {
      if (day.date > maxDate) maxDate = day.date;
      if (day.date < start || day.date > end) continue;
      for (const g of day.games ?? []) {
        const id = String(g.id);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(formatGame(g, day.date));
      }
    }

    // Avance après la dernière date couverte par la semaine ; si la semaine
    // n'a fait progresser le curseur d'aucun jour (réponse vide), on avance
    // d'un jour pour ne rien sauter.
    const stepped = addDays(maxDate, 1);
    cursor = stepped > cursor ? stepped : addDays(cursor, 1);
  }

  out.sort((a, b) =>
    a.gameDate === b.gameDate
      ? String(a.id).localeCompare(String(b.id))
      : a.gameDate.localeCompare(b.gameDate),
  );

  setCached(key, out, 10 * 60_000);
  return out;
}

/**
 * Point d'ancrage du calendrier : renvoie la date « courante » selon l'API NHL
 * (et non l'horloge de la machine) + les bornes de la saison si disponibles.
 * Permet à la page calendrier de s'ouvrir sur le bon mois même si l'horloge
 * locale est décalée par rapport aux données réelles de l'API.
 */
export async function fetchScheduleAnchor(): Promise<{ today: string; seasonStart: string; seasonEnd: string }> {
  const clockToday = new Date().toISOString().slice(0, 10);

  if (USE_MOCK) {
    const dates = (MOCK_GAMES_FULL as any[]).map((g) => g.gameDate).sort();
    return { today: dates[0] ?? clockToday, seasonStart: dates[0] ?? '', seasonEnd: dates[dates.length - 1] ?? '' };
  }

  const cached = getCached<{ today: string; seasonStart: string; seasonEnd: string }>('sched:anchor');
  if (cached) return cached;

  const data = await fetchNHL<any>('v1/schedule/now');
  const out = {
    today:       data.gameWeek?.[0]?.date ?? clockToday,
    seasonStart: data.regularSeasonStartDate ?? data.preSeasonStartDate ?? '',
    seasonEnd:   data.playoffEndDate ?? data.regularSeasonEndDate ?? '',
  };
  setCached('sched:anchor', out, 60 * 60_000); // 1 h
  return out;
}

export async function fetchLiveGames(): Promise<any[]> {
  if (USE_MOCK) return (MOCK_GAMES_FULL as any[]).filter((g) => g.status === 'live');
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
  if (USE_MOCK) {
    const g = (MOCK_GAMES_FULL as any[]).find((x) => x.id === gameId);
    if (g) return g;
    throw Object.assign(new Error('Game not found'), { status: 404 });
  }
  try {
    const data = await fetchNHL<any>(`v1/gamecenter/${gameId}/landing`);
    return formatGame(data);
  } catch {
    throw Object.assign(new Error('Game not found'), { status: 404 });
  }
}

// --- Boxscore (per-player final stats, used for player-prop settlement) ---

export interface BoxscorePlayerStats {
  playerId:      string;
  goals:         number;
  assists:       number;
  points:        number;
  shots:         number;
  hits:          number;
  blockedShots:  number;
  pim:           number;
  /** Minutes on ice (decimal), parsed from the "MM:SS" boxscore string. */
  toi:           number;
  /** Goalie only — undefined for skaters. */
  saves?:        number;
  shotsAgainst?: number;
  goalsAgainst?: number;
  decision?:     string; // 'W' | 'L' | 'O'
}

function numOrUndefined(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Parses NHL's "27/30" saves/shots-against string into { saves, shotsAgainst }. */
function parseSavesString(s: unknown): { saves?: number; shotsAgainst?: number } {
  if (typeof s !== 'string' || !s.includes('/')) return {};
  const [a, b] = s.split('/').map((x) => Number(x.trim()));
  return { saves: Number.isFinite(a) ? a : undefined, shotsAgainst: Number.isFinite(b) ? b : undefined };
}

/** Parses NHL's "MM:SS" time-on-ice string into decimal minutes. */
function parseToiMinutes(s: unknown): number {
  if (typeof s !== 'string' || !s.includes(':')) return 0;
  const [m, sec] = s.split(':').map((x) => Number(x.trim()));
  if (!Number.isFinite(m) || !Number.isFinite(sec)) return 0;
  return +(m + sec / 60).toFixed(2);
}

function normalizeSkater(p: any): BoxscorePlayerStats {
  const goals   = numOrUndefined(p.goals)   ?? 0;
  const assists = numOrUndefined(p.assists) ?? 0;
  return {
    playerId:     String(p.playerId ?? p.id),
    goals,
    assists,
    points:       numOrUndefined(p.points) ?? (goals + assists),
    shots:        numOrUndefined(p.sog ?? p.shots ?? p.shotsOnGoal) ?? 0,
    hits:         numOrUndefined(p.hits) ?? 0,
    blockedShots: numOrUndefined(p.blockedShots ?? p.blockedShotsAgainst) ?? 0,
    pim:          numOrUndefined(p.pim ?? p.penaltyMinutes) ?? 0,
    toi:          parseToiMinutes(p.toi),
  };
}

function normalizeGoalie(p: any): BoxscorePlayerStats {
  const parsed = parseSavesString(p.saveShotsAgainst);
  return {
    playerId:     String(p.playerId ?? p.id),
    goals:        numOrUndefined(p.goals)   ?? 0,
    assists:      numOrUndefined(p.assists) ?? 0,
    points:       numOrUndefined(p.points)  ?? 0,
    shots:        0,
    hits:         0,
    blockedShots: 0,
    pim:          numOrUndefined(p.pim ?? p.penaltyMinutes) ?? 0,
    toi:          parseToiMinutes(p.toi),
    saves:        numOrUndefined(p.saves) ?? parsed.saves,
    shotsAgainst: numOrUndefined(p.shotsAgainst) ?? parsed.shotsAgainst,
    goalsAgainst: numOrUndefined(p.goalsAgainst),
    decision:     typeof p.decision === 'string' ? p.decision : undefined,
  };
}

/**
 * Fetches the final boxscore for a game and returns a Map of playerId → stats,
 * for both rosters combined. Returns null if the boxscore can't be fetched or
 * parsed — callers must treat that as "can't settle yet", never as zero stats.
 */
export async function fetchGameBoxscore(gameId: string): Promise<Map<string, BoxscorePlayerStats> | null> {
  if (USE_MOCK) return null; // no boxscore data in mock mode — player props stay pending

  const cacheKey = `box:${gameId}`;
  const cached = getCached<Map<string, BoxscorePlayerStats>>(cacheKey);
  if (cached) return cached;

  let data: any;
  try {
    data = await fetchNHL<any>(`v1/gamecenter/${gameId}/boxscore`);
  } catch {
    return null;
  }

  const stats = data?.playerByGameStats;
  if (!stats) return null;

  const out = new Map<string, BoxscorePlayerStats>();
  try {
    for (const side of [stats.awayTeam, stats.homeTeam]) {
      if (!side) continue;
      for (const p of [...(side.forwards ?? []), ...(side.defense ?? [])]) {
        const s = normalizeSkater(p);
        out.set(s.playerId, s);
      }
      for (const p of side.goalies ?? []) {
        const s = normalizeGoalie(p);
        out.set(s.playerId, s);
      }
    }
  } catch {
    return null; // unexpected shape → don't guess, let settlement stay pending
  }

  if (out.size === 0) return null;
  // Final boxscores never change — cache for a long time.
  setCached(cacheKey, out, 6 * 60 * 60_000);
  return out;
}

// --- Scoring plays (goal order + strength state, used for first/last goal
// scorer and power-play point settlement) -----------------------------------

export interface ScoringGoal {
  playerId:        string;
  assistPlayerIds: string[];
  /** 'ev' | 'pp' | 'sh' — power-play/shorthanded/even-strength. */
  strength:        string;
  /** True if the home team scored this goal. */
  isHome:          boolean;
  periodNumber:    number;
  periodType:      string; // 'REG' | 'OT' | 'SO'
  /** Seconds elapsed within the period — used to order goals within a period. */
  elapsedSeconds:  number;
}

function parseTimeToSeconds(s: unknown): number {
  if (typeof s !== 'string' || !s.includes(':')) return 0;
  const [m, sec] = s.split(':').map((x) => Number(x.trim()));
  if (!Number.isFinite(m) || !Number.isFinite(sec)) return 0;
  return m * 60 + sec;
}

/**
 * Fetches the final game's scoring summary (goal-by-goal, in chronological
 * order, with strength state) via the landing endpoint. Returns null if it
 * can't be fetched or parsed — callers must treat that as "can't settle yet".
 * Shootout goals are excluded (they aren't "goals" for scorer/PP props).
 */
export async function fetchGameScoringPlays(gameId: string): Promise<ScoringGoal[] | null> {
  if (USE_MOCK) return null; // no scoring-play data in mock mode

  const cacheKey = `scoring:${gameId}`;
  const cached = getCached<ScoringGoal[]>(cacheKey);
  if (cached) return cached;

  let data: any;
  try {
    data = await fetchNHL<any>(`v1/gamecenter/${gameId}/landing`);
  } catch {
    return null;
  }

  const periods = data?.summary?.scoring;
  if (!Array.isArray(periods)) return null;

  const out: ScoringGoal[] = [];
  try {
    for (const period of periods) {
      const periodType = String(period?.periodDescriptor?.periodType ?? '');
      if (periodType === 'SO') continue; // shootout attempts aren't "goals"
      const periodNumber = Number(period?.periodDescriptor?.number ?? 0);
      for (const g of period?.goals ?? []) {
        if (g?.playerId == null) continue;
        if (typeof g.isHome !== 'boolean') throw new Error('unexpected goal shape'); // caught below → null
        out.push({
          playerId:        String(g.playerId),
          assistPlayerIds: (g.assists ?? []).map((a: any) => String(a.playerId)).filter(Boolean),
          strength:        String(g.strength ?? 'ev').toLowerCase(),
          isHome:          g.isHome,
          periodNumber,
          periodType,
          elapsedSeconds:  parseTimeToSeconds(g.timeInPeriod),
        });
      }
    }
  } catch {
    return null; // unexpected shape → don't guess, let settlement stay pending
  }

  // Chronological order: by period, then by elapsed time within the period.
  out.sort((a, b) => a.periodNumber - b.periodNumber || a.elapsedSeconds - b.elapsedSeconds);

  // Final games' scoring never changes — cache for a long time.
  setCached(cacheKey, out, 6 * 60 * 60_000);
  return out;
}

// --- Faceoff wins (play-by-play) --------------------------------------------
// The boxscore only exposes a faceoff *percentage* per player, not a raw win
// count, so "Over/Under N faceoff wins" can't be settled from it. The full
// play-by-play feed lists every individual faceoff event with a winner, so we
// tally those instead. This is a heavier fetch than the boxscore (the full
// event log for the game), which is exactly why this market was left for
// later rather than shipped with the others.

/**
 * Fetches the final game's play-by-play log and tallies faceoff wins per
 * player. Returns null if it can't be fetched or parsed.
 */
export async function fetchGameFaceoffWins(gameId: string): Promise<Map<string, number> | null> {
  if (USE_MOCK) return null; // no play-by-play data in mock mode

  const cacheKey = `faceoffs:${gameId}`;
  const cached = getCached<Map<string, number>>(cacheKey);
  if (cached) return cached;

  let data: any;
  try {
    data = await fetchNHL<any>(`v1/gamecenter/${gameId}/play-by-play`);
  } catch {
    return null;
  }

  const plays = data?.plays;
  if (!Array.isArray(plays)) return null;

  const out = new Map<string, number>();
  try {
    for (const play of plays) {
      if (play?.typeDescKey !== 'faceoff') continue;
      const winnerId = play?.details?.winningPlayerId;
      if (winnerId == null) continue;
      const key = String(winnerId);
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  } catch {
    return null; // unexpected shape → don't guess, let settlement stay pending
  }

  // Final games' play-by-play never changes — cache for a long time.
  setCached(cacheKey, out, 6 * 60 * 60_000);
  return out;
}

// --- Players --------------------------------------------------------------

export async function fetchTopPlayers(): Promise<any[]> {
  if (USE_MOCK) return MOCK_TOP_PLAYERS as any[];
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
      teamId:      (p.teamAbbrev ?? p.teamAbbreviation ?? '').toLowerCase(),
      position:    p.positionCode ?? p.position ?? 'F',
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
  if (USE_MOCK) {
    const mp = MOCK_PLAYER_BY_ID[String(playerId)];
    if (mp) return mp;
  }
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
    // Stats gardien (présentes uniquement si position === 'G' dans seasonTotals)
    savePct:          cur.savePctg        ?? null,
    goalsAgainstAvg:  cur.goalsAgainstAvg ?? null,
    wins:             cur.wins            ?? null,
    shutouts:         cur.shutouts        ?? null,
    shotsAgainst:     cur.shotsAgainst    ?? null,
    goalsAgainst:     cur.goalsAgainst    ?? null,
  };
}

export async function searchPlayers(q: string): Promise<any[]> {
  if (!q.trim()) return [];
  try {
    // This endpoint lives on search.d3.nhle.com, not api-web.nhle.com — it
    // returns a bare array (not wrapped in { players: [...] }).
    const data = await fetchNHLSearch<any>(
      `v1/search/player?culture=en-us&limit=20&q=${encodeURIComponent(q)}&active=true`
    );
    const results: any[] = Array.isArray(data) ? data : (data?.players ?? []);
    return results.map((p: any) => ({
      id:       String(p.playerId ?? p.id),
      name:     p.name ?? [p.firstName, p.lastName].filter(Boolean).join(' '),
      teamId:   (p.teamAbbrev ?? p.teamAbbreviation ?? '').toLowerCase(),
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

/**
 * Last 6 NHL regular seasons of per-player stats for a team — powers the
 * Bet365-style charts grid. Players are split into skaters and goalies, and a
 * player traded mid-season (multiple NHL rows for the same seasonId) is folded
 * into a single per-season entry: counting stats are summed, goalie rate stats
 * (SV%, GAA) are games-weighted.
 */
export async function fetchTeamPlayerSeasons(abbr: string): Promise<any> {
  const upper    = abbr.toUpperCase();
  const cacheKey = `player_seasons_${upper}`;
  const cached   = getCached<any>(cacheKey);
  if (cached) return cached;

  const season     = currentSeason();
  const rosterData = await fetchNHL<any>(`v1/roster/${upper}/${season}`);
  const skaterRoster: any[] = [
    ...(rosterData.forwards   ?? []),
    ...(rosterData.defensemen ?? []),
  ];
  const goalieRoster: any[] = rosterData.goalies ?? [];
  const allPlayers          = [...skaterRoster, ...goalieRoster];

  const landings = await Promise.allSettled(
    allPlayers.map(p => fetchNHL<any>(`v1/player/${p.id}/landing`))
  );

  const skaters: any[]        = [];
  const goalies: any[]        = [];
  const seasonIds: Set<number> = new Set();

  for (let i = 0; i < allPlayers.length; i++) {
    const roster = allPlayers[i];
    const res    = landings[i];
    if (res.status === 'rejected') continue;
    const data     = res.value as any;
    const isGoalie = (roster.positionCode ?? data.position) === 'G';

    // NHL regular-season rows only.
    const rows: any[] = (data.seasonTotals ?? []).filter(
      (s: any) => s.leagueAbbrev === 'NHL' && s.gameTypeId === 2
    );
    if (rows.length === 0) continue;

    // Fold split seasons (traded mid-year) into one entry per seasonId.
    const bySeason = new Map<number, any>();
    for (const s of rows) {
      const id  = Number(s.season);
      const gp  = s.gamesPlayed ?? 0;
      const cur = bySeason.get(id) ?? {
        seasonId: id, gp: 0, goals: 0, assists: 0, points: 0, plusMinus: 0,
        shots: 0, ppPoints: 0, wins: 0, shutouts: 0, _svW: 0, _gaaW: 0,
        pim: 0, powerPlayGoals: 0, shorthandedPoints: 0, _foW: 0, _toiW: 0,
        losses: 0, otLosses: 0,
      };
      cur.gp  += gp;
      cur.pim += s.pim ?? 0;
      if (isGoalie) {
        cur.wins     += s.wins     ?? 0;
        cur.losses   += s.losses   ?? 0;
        cur.otLosses += s.otLosses ?? 0;
        cur.shutouts += s.shutouts ?? 0;
        cur._svW     += (s.savePctg        ?? 0) * gp;
        cur._gaaW    += (s.goalsAgainstAvg ?? 0) * gp;
      } else {
        cur.goals             += s.goals             ?? 0;
        cur.assists            += s.assists           ?? 0;
        cur.points             += s.points            ?? 0;
        cur.plusMinus          += s.plusMinus         ?? 0;
        cur.shots              += s.shots             ?? 0;
        cur.ppPoints           += s.powerPlayPoints   ?? 0;
        cur.powerPlayGoals     += s.powerPlayGoals    ?? 0;
        cur.shorthandedPoints  += s.shorthandedPoints ?? 0;
        cur._foW               += (s.faceoffWinningPctg ?? 0) * gp;
        cur._toiW              += parseToiMinutes(s.avgToi) * gp;
      }
      bySeason.set(id, cur);
    }

    // Newest 6 seasons, finalised.
    const seasons = [...bySeason.values()]
      .sort((a, b) => b.seasonId - a.seasonId)
      .slice(0, 6)
      .map((s) => {
        seasonIds.add(s.seasonId);
        if (isGoalie) {
          s.savePct = s.gp > 0 ? Math.round((s._svW  / s.gp) * 1000) / 1000 : null;
          s.gaa     = s.gp > 0 ? Math.round((s._gaaW / s.gp) * 100)  / 100  : null;
        } else {
          s.shootingPct = s.shots > 0 ? Math.round((s.goals / s.shots) * 1000) / 10 : 0;
          s.faceoffPct  = s.gp > 0 ? Math.round((s._foW  / s.gp) * 1000) / 10 : null;
          s.avgToi      = s.gp > 0 ? Math.round((s._toiW / s.gp) * 100)  / 100 : null;
        }
        delete s._svW; delete s._gaaW; delete s._foW; delete s._toiW;
        return s;
      });

    const entry = {
      id:       String(roster.id),
      name:     [roster.firstName?.default, roster.lastName?.default].filter(Boolean).join(' '),
      position: roster.positionCode ?? (isGoalie ? 'G' : 'F'),
      number:   roster.sweaterNumber ?? 0,
      seasons,
    };
    (isGoalie ? goalies : skaters).push(entry);
  }

  // Column headers = the 6 most-recent seasons present across the roster.
  const seasonList = [...seasonIds].sort((a, b) => b - a).slice(0, 6);
  const recent     = seasonList[0];
  const recentVal  = (p: any, k: string) =>
    p.seasons.find((s: any) => s.seasonId === recent)?.[k] ?? -1;

  skaters.sort((a, b) => recentVal(b, 'points') - recentVal(a, 'points'));
  goalies.sort((a, b) => recentVal(b, 'gp')     - recentVal(a, 'gp'));

  const out = { teamAbbr: upper, seasonIds: seasonList, skaters, goalies };
  setCached(cacheKey, out, 30 * 60_000);
  return out;
}

/**
 * Per-opponent splits for a team's current roster in a given season — powers
 * the "average per game against a chosen team" column. For every player we pull
 * the season game log and bucket their stats by `opponentAbbrev`, so the client
 * can compute an average vs any opponent without re-fetching. Counting stats are
 * summed per opponent; the client divides by games-vs-opponent for the average.
 */
export async function fetchTeamOpponentSplits(abbr: string, season: string): Promise<any> {
  const upper    = abbr.toUpperCase();
  const cacheKey = `opp_splits_${upper}_${season}`;
  const cached   = getCached<any>(cacheKey);
  if (cached) return cached;

  const rosterData = await fetchNHL<any>(`v1/roster/${upper}/${currentSeason()}`);
  const players = [
    ...(rosterData.forwards   ?? []).map((p: any) => ({ ...p, isGoalie: false })),
    ...(rosterData.defensemen ?? []).map((p: any) => ({ ...p, isGoalie: false })),
    ...(rosterData.goalies    ?? []).map((p: any) => ({ ...p, isGoalie: true  })),
  ];

  const logs = await Promise.allSettled(
    players.map(p => fetchNHL<any>(`v1/player/${p.id}/game-log/${season}/2`)),
  );

  const opponents: Set<string> = new Set();
  const skaters: any[] = [];
  const goalies: any[] = [];

  for (let i = 0; i < players.length; i++) {
    const p   = players[i];
    const res = logs[i];
    if (res.status === 'rejected') continue;
    const gameLog: any[] = (res.value as any).gameLog ?? [];
    if (gameLog.length === 0) continue;

    // Chronological (NHL returns most-recent-first) → per-game series for the
    // line chart, plus the per-opponent buckets for the vs-team column.
    const ordered = [...gameLog].sort((a, b) => String(a.gameDate).localeCompare(String(b.gameDate)));

    const vs: Record<string, any> = {};
    const series: any[] = [];
    for (const g of ordered) {
      series.push(p.isGoalie
        ? {
            wins: g.decision === 'W' ? 1 : 0,
            shutouts:     g.shutouts     ?? 0,
            saves:        g.saves        ?? 0,
            shotsAgainst: g.shotsAgainst ?? 0,
            goalsAgainst: g.goalsAgainst ?? 0,
            savePct:      g.savePctg ?? null,
          }
        : {
            goals:     g.goals           ?? 0,
            assists:   g.assists         ?? 0,
            points:    g.points          ?? 0,
            plusMinus: g.plusMinus       ?? 0,
            shots:     g.shots           ?? 0,
            ppPoints:  g.powerPlayPoints ?? 0,
          });

      const opp = g.opponentAbbrev;
      if (!opp) continue;
      opponents.add(opp);
      const cur = vs[opp] ?? (p.isGoalie
        ? { gp: 0, wins: 0, shutouts: 0, saves: 0, shotsAgainst: 0, goalsAgainst: 0 }
        : { gp: 0, goals: 0, assists: 0, points: 0, plusMinus: 0, shots: 0, ppPoints: 0 });
      cur.gp += 1;
      if (p.isGoalie) {
        if (g.decision === 'W') cur.wins += 1;
        cur.shutouts     += g.shutouts     ?? 0;
        cur.saves        += g.saves        ?? 0;
        cur.shotsAgainst += g.shotsAgainst ?? 0;
        cur.goalsAgainst += g.goalsAgainst ?? 0;
      } else {
        cur.goals     += g.goals           ?? 0;
        cur.assists   += g.assists         ?? 0;
        cur.points    += g.points          ?? 0;
        cur.plusMinus += g.plusMinus       ?? 0;
        cur.shots     += g.shots           ?? 0;
        cur.ppPoints  += g.powerPlayPoints ?? 0;
      }
      vs[opp] = cur;
    }
    (p.isGoalie ? goalies : skaters).push({ id: String(p.id), vs, series });
  }

  const out = {
    teamAbbr:  upper,
    season:    Number(season),
    opponents: [...opponents].sort(),
    skaters,
    goalies,
  };
  setCached(cacheKey, out, 30 * 60_000);
  return out;
}

/**
 * Official team stats for a given season (NHL stats API team/summary) plus
 * per-opponent goals-for / goals-against / wins derived from that season's
 * schedule — powers the team-stats table (rows = metrics, same 3 columns).
 */
export async function fetchTeamSeasonOfficial(abbr: string, season: string): Promise<any> {
  const upper    = abbr.toUpperCase();
  const cacheKey = `team_season_${upper}_${season}`;
  const cached   = getCached<any>(cacheKey);
  if (cached) return cached;

  // Official summary for the season.
  let official: any = null;
  try {
    const cayenne = encodeURIComponent(`seasonId=${season} and gameTypeId=2`);
    const res = await fetch(
      `${STATS_BASE}/team/summary?limit=-1&cayenneExp=${cayenne}`,
      { headers: { 'User-Agent': 'IceEdge/1.0', Accept: 'application/json' } },
    );
    if (res.ok) {
      const data = (await res.json()) as any;
      const row  = (data.data ?? []).find(
        (t: any) => TEAM_NAME_TO_ABBR[t.teamFullName ?? ''] === upper,
      );
      if (row) {
        const gp = row.gamesPlayed || 82;
        official = {
          gamesPlayed:         gp,
          wins:                row.wins   ?? 0,
          losses:              row.losses ?? 0,
          points:              row.points ?? 0,
          goalsFor:            row.goalsFor     ?? 0,
          goalsAgainst:        row.goalsAgainst ?? 0,
          goalsForPerGame:     +(row.goalsForPerGame     ?? (row.goalsFor     ?? 0) / gp).toFixed(2),
          goalsAgainstPerGame: +(row.goalsAgainstPerGame ?? (row.goalsAgainst ?? 0) / gp).toFixed(2),
          ppPct:               Math.round((row.powerPlayPct   ?? 0) * 1000) / 10,
          pkPct:               Math.round((row.penaltyKillPct ?? 0) * 1000) / 10,
          pointPct:            Math.round((row.pointPct       ?? 0) * 1000) / 10,
          faceoffPct:          Math.round((row.faceoffWinPct  ?? 0) * 1000) / 10,
          shotsForPerGame:     +(row.shotsForPerGame     ?? 0).toFixed(2),
          shotsAgainstPerGame: +(row.shotsAgainstPerGame ?? 0).toFixed(2),
        };
      }
    }
  } catch { /* summary unavailable → official stays null */ }

  // Per-opponent splits + record breakdowns from the season schedule (played
  // games only). Result type: win / OT-loss (OT or SO) / regulation loss.
  const vsOpponent: Record<string, any> = {};
  type PlayedGame = { isHome: boolean; result: 'W' | 'OT' | 'L'; diff: number };
  const played: PlayedGame[] = [];
  try {
    const sched = await fetchNHL<any>(`v1/club-schedule-season/${upper}/${season}`);
    const games = (sched.games ?? [])
      .filter((g: any) => g.gameType === 2)
      .sort((a: any, b: any) => String(a.gameDate).localeCompare(String(b.gameDate)));
    for (const g of games) {
      const home = g.homeTeam?.abbrev;
      const away = g.awayTeam?.abbrev;
      const hs   = g.homeTeam?.score;
      const as   = g.awayTeam?.score;
      if (hs == null || as == null) continue; // not yet played
      const isHome = home === upper;
      const opp    = isHome ? away : home;
      const gf     = isHome ? hs : as;
      const ga     = isHome ? as : hs;
      const lastPeriod = g.gameOutcome?.lastPeriodType ?? 'REG';
      const win = gf > ga;
      const otl = !win && (lastPeriod === 'OT' || lastPeriod === 'SO');
      const result: 'W' | 'OT' | 'L' = win ? 'W' : otl ? 'OT' : 'L';

      played.push({ isHome, result, diff: Math.abs(gf - ga) });

      if (opp) {
        const cur = vsOpponent[opp] ?? { gp: 0, goalsFor: 0, goalsAgainst: 0, wins: 0, losses: 0, otLosses: 0 };
        cur.gp += 1; cur.goalsFor += gf; cur.goalsAgainst += ga;
        if (win) cur.wins += 1; else if (otl) cur.otLosses += 1; else cur.losses += 1;
        vsOpponent[opp] = cur;
      }
    }
  } catch { /* schedule unavailable → vsOpponent/record stay empty */ }

  const tally = (list: PlayedGame[]) => {
    const r = { w: 0, l: 0, otl: 0 };
    for (const g of list) { if (g.result === 'W') r.w += 1; else if (g.result === 'OT') r.otl += 1; else r.l += 1; }
    return r;
  };
  let streak = '';
  if (played.length) {
    const last = played[played.length - 1].result;
    let n = 0;
    for (let i = played.length - 1; i >= 0 && played[i].result === last; i--) n += 1;
    streak = `${last}${n}`;
  }
  const record = played.length
    ? {
        overall: tally(played),
        home:    tally(played.filter((g) => g.isHome)),
        away:    tally(played.filter((g) => !g.isHome)),
        last10:  tally(played.slice(-10)),
        oneGoal: tally(played.filter((g) => g.diff === 1)),
        streak,
      }
    : null;

  const out = { teamAbbr: upper, season: Number(season), official, vsOpponent, record };
  setCached(cacheKey, out, 30 * 60_000);
  return out;
}

// --- Team summary stats (PP/PK réels, tirs, mises au jeu) -------------------
// api.nhle.com/stats/rest — l'endpoint standings n'a PAS ces champs.

const STATS_BASE = 'https://api.nhle.com/stats/rest/en';

/**
 * League leaders for a season — powers the "All Players" charts page.
 *
 * Uses the NHL stats REST summary endpoints, which (unlike the leaders
 * endpoints in api-web) return a full stat line per player AND support
 * server-side sorting, so we can ask for "top N by <metric>" directly.
 *
 * Rows come back shaped like the client's `PlayerSeasonStat` so the existing
 * metric formatters on the charts page can render them unchanged.
 */
const LEADER_SORT_SKATER: Record<string, string> = {
  points: 'points', goals: 'goals', assists: 'assists', plusMinus: 'plusMinus',
  shots: 'shots', ppPoints: 'ppPoints', shootingPct: 'shootingPct',
  pim: 'penaltyMinutes', powerPlayGoals: 'ppGoals', shorthandedPoints: 'shPoints',
  faceoffPct: 'faceoffWinPct', avgToi: 'timeOnIcePerGame',
};
const LEADER_SORT_GOALIE: Record<string, string> = {
  wins: 'wins', savePct: 'savePct', gaa: 'goalsAgainstAverage',
  shutouts: 'shutouts', losses: 'losses', otLosses: 'otLosses',
};

export async function fetchPlayerLeaders(
  seasonArg: string | undefined,
  view: 'skater' | 'goalie',
  sortKey: string,
  limit: number,
): Promise<any> {
  const season   = seasonArg && /^\d{8}$/.test(seasonArg) ? seasonArg : currentSeason();
  const isGoalie = view === 'goalie';
  const map      = isGoalie ? LEADER_SORT_GOALIE : LEADER_SORT_SKATER;
  const key      = map[sortKey] ? sortKey : (isGoalie ? 'wins' : 'points');
  const prop     = map[key];
  // GAA sorts ascending (lower is better); every other metric is "more is better".
  const dir      = key === 'gaa' ? 'ASC' : 'DESC';
  const n        = Math.min(Math.max(limit || 20, 1), 100);

  const cacheKey = `leaders_${season}_${view}_${key}_${n}`;
  const cached   = getCached<any>(cacheKey);
  if (cached) return cached;

  const sort    = encodeURIComponent(JSON.stringify([{ property: prop, direction: dir }]));
  const cayenne = encodeURIComponent(`seasonId=${season} and gameTypeId=2`);
  const res = await fetch(
    `${STATS_BASE}/${isGoalie ? 'goalie' : 'skater'}/summary` +
      `?isAggregate=false&isGame=false&start=0&limit=${n}&sort=${sort}&cayenneExp=${cayenne}`,
    { headers: { 'User-Agent': 'IceEdge/1.0', Accept: 'application/json' } },
  );
  if (!res.ok) {
    throw Object.assign(
      new Error(`NHL stats API ${res.status} for player leaders`),
      { status: res.status },
    );
  }
  const data = (await res.json()) as any;

  const players = (data.data ?? []).map((r: any) => ({
    id:       String(r.playerId),
    name:     isGoalie ? r.goalieFullName : r.skaterFullName,
    // `teamAbbrevs` is comma-separated when a player was traded mid-season.
    teamAbbr: String(r.teamAbbrevs ?? '').split(',')[0].trim().toUpperCase(),
    position: isGoalie ? 'G' : (r.positionCode ?? 'F'),
    stat: isGoalie
      ? {
          seasonId: Number(season),
          gp:       r.gamesPlayed ?? 0,
          wins:     r.wins     ?? 0,
          losses:   r.losses   ?? 0,
          otLosses: r.otLosses ?? 0,
          shutouts: r.shutouts ?? 0,
          savePct:  r.savePct != null ? Math.round(r.savePct * 1000) / 1000 : null,
          gaa:      r.goalsAgainstAverage != null
            ? Math.round(r.goalsAgainstAverage * 100) / 100
            : null,
        }
      : {
          seasonId:          Number(season),
          gp:                r.gamesPlayed ?? 0,
          goals:             r.goals      ?? 0,
          assists:           r.assists    ?? 0,
          points:            r.points     ?? 0,
          plusMinus:         r.plusMinus  ?? 0,
          shots:             r.shots      ?? 0,
          ppPoints:          r.ppPoints   ?? 0,
          pim:               r.penaltyMinutes ?? 0,
          powerPlayGoals:    r.ppGoals    ?? 0,
          shorthandedPoints: r.shPoints   ?? 0,
          // NHL returns these as 0–1 ratios; the client expects 0–100.
          shootingPct: r.shootingPct   != null ? Math.round(r.shootingPct   * 1000) / 10 : 0,
          faceoffPct:  r.faceoffWinPct != null ? Math.round(r.faceoffWinPct * 1000) / 10 : null,
          // ...and time-on-ice per game in seconds; the client expects minutes.
          avgToi: r.timeOnIcePerGame != null
            ? Math.round((r.timeOnIcePerGame / 60) * 100) / 100
            : null,
        },
  }));

  const out = { season: Number(season), view, sort: key, players };
  setCached(cacheKey, out, 30 * 60_000);
  return out;
}

const TEAM_NAME_TO_ABBR: Record<string, string> = {
  'Anaheim Ducks': 'ANA',         'Arizona Coyotes': 'ARI',
  'Boston Bruins': 'BOS',         'Buffalo Sabres': 'BUF',
  'Calgary Flames': 'CGY',        'Carolina Hurricanes': 'CAR',
  'Chicago Blackhawks': 'CHI',    'Colorado Avalanche': 'COL',
  'Columbus Blue Jackets': 'CBJ', 'Dallas Stars': 'DAL',
  'Detroit Red Wings': 'DET',     'Edmonton Oilers': 'EDM',
  'Florida Panthers': 'FLA',      'Los Angeles Kings': 'LAK',
  'Minnesota Wild': 'MIN',        'Montréal Canadiens': 'MTL',
  'Montreal Canadiens': 'MTL',    'Nashville Predators': 'NSH',
  'New Jersey Devils': 'NJD',     'New York Islanders': 'NYI',
  'New York Rangers': 'NYR',      'Ottawa Senators': 'OTT',
  'Philadelphia Flyers': 'PHI',   'Pittsburgh Penguins': 'PIT',
  'San Jose Sharks': 'SJS',       'Seattle Kraken': 'SEA',
  'St. Louis Blues': 'STL',       'Tampa Bay Lightning': 'TBL',
  'Toronto Maple Leafs': 'TOR',   'Utah Hockey Club': 'UTA',
  'Utah Mammoth': 'UTA',          'Vancouver Canucks': 'VAN',
  'Vegas Golden Knights': 'VGK',  'Washington Capitals': 'WSH',
  'Winnipeg Jets': 'WPG',
};

/**
 * Every team's season summary in one call — powers the "All Teams" charts page.
 * The NHL team/summary endpoint returns all 32 rows at once, so the client can
 * sort them locally; no per-metric round trip is needed the way it is for
 * players (where the league has ~940 skaters and we only want the top N).
 */
export async function fetchAllTeamsSeason(seasonArg?: string): Promise<any> {
  const season   = seasonArg && /^\d{8}$/.test(seasonArg) ? seasonArg : currentSeason();
  const cacheKey = `all_teams_${season}`;
  const cached   = getCached<any>(cacheKey);
  if (cached) return cached;

  const cayenne = encodeURIComponent(`seasonId=${season} and gameTypeId=2`);
  const res = await fetch(
    `${STATS_BASE}/team/summary?limit=-1&cayenneExp=${cayenne}`,
    { headers: { 'User-Agent': 'IceEdge/1.0', Accept: 'application/json' } },
  );
  if (!res.ok) {
    throw Object.assign(
      new Error(`NHL stats API ${res.status} for team summary`),
      { status: res.status },
    );
  }
  const data = (await res.json()) as any;

  const teams = (data.data ?? []).map((row: any) => {
    const gp = row.gamesPlayed || 0;
    const gf = row.goalsFor     ?? 0;
    const ga = row.goalsAgainst ?? 0;
    return {
      abbr: TEAM_NAME_TO_ABBR[row.teamFullName ?? ''] ?? '',
      name: row.teamFullName ?? '',
      gamesPlayed: gp,
      wins:     row.wins     ?? 0,
      losses:   row.losses   ?? 0,
      otLosses: row.otLosses ?? 0,
      points:   row.points   ?? 0,
      goalsFor: gf,
      goalsAgainst: ga,
      goalDiff: gf - ga,
      goalsForPerGame:     +(row.goalsForPerGame     ?? (gp ? gf / gp : 0)).toFixed(2),
      goalsAgainstPerGame: +(row.goalsAgainstPerGame ?? (gp ? ga / gp : 0)).toFixed(2),
      shotsForPerGame:     +(row.shotsForPerGame     ?? 0).toFixed(2),
      shotsAgainstPerGame: +(row.shotsAgainstPerGame ?? 0).toFixed(2),
      // NHL sends these as 0–1 ratios; the client renders 0–100.
      ppPct:      Math.round((row.powerPlayPct   ?? 0) * 1000) / 10,
      pkPct:      Math.round((row.penaltyKillPct ?? 0) * 1000) / 10,
      pointPct:   Math.round((row.pointPct       ?? 0) * 1000) / 10,
      faceoffPct: Math.round((row.faceoffWinPct  ?? 0) * 1000) / 10,
      shutouts:   row.teamShutouts ?? 0,
    };
  // A renamed franchise missing from the abbreviation map would have no logo
  // and no working link, so drop it rather than render a dead row.
  }).filter((x: any) => x.abbr);

  const out = { season: Number(season), teams };
  setCached(cacheKey, out, 30 * 60_000);
  return out;
}

export interface TeamSummaryStats {
  ppPct:           number;  // 0–100
  pkPct:           number;  // 0–100
  shotsForPg:      number;
  shotsAgainstPg:  number;
  faceoffPct:      number;  // 0–100
}

/** PP%, PK%, tirs/match et mises au jeu de la saison en cours, par abréviation. */
export async function fetchTeamSummaryStats(): Promise<Record<string, TeamSummaryStats>> {
  const cached = getCached<Record<string, TeamSummaryStats>>('teamSummary');
  if (cached) return cached;

  const cayenne = encodeURIComponent(
    `seasonId=${currentSeason()} and gameTypeId=2`
  );
  const res = await fetch(
    `${STATS_BASE}/team/summary?limit=-1&cayenneExp=${cayenne}`,
    { headers: { 'User-Agent': 'IceEdge/1.0', Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`NHL stats API ${res.status} for team/summary`);
  const data = (await res.json()) as any;

  const out: Record<string, TeamSummaryStats> = {};
  for (const t of data.data ?? []) {
    const abbr = TEAM_NAME_TO_ABBR[t.teamFullName ?? ''];
    if (!abbr) continue;
    out[abbr] = {
      ppPct:          Math.round((t.powerPlayPct   ?? 0.20) * 1000) / 10,
      pkPct:          Math.round((t.penaltyKillPct ?? 0.80) * 1000) / 10,
      shotsForPg:     +(t.shotsForPerGame     ?? 30).toFixed(2),
      shotsAgainstPg: +(t.shotsAgainstPerGame ?? 30).toFixed(2),
      faceoffPct:     Math.round((t.faceoffWinPct  ?? 0.50) * 1000) / 10,
    };
  }

  setCached('teamSummary', out, 10 * 60_000);
  return out;
}

// --- Repos / back-to-back ---------------------------------------------------

export interface TeamRestInfo {
  restDays: number;   // jours depuis le dernier match (cap 7)
  b2b:      0 | 1;    // back-to-back (a joué hier)
  dense3in4: number;  // nb de matchs joués dans les 3 jours précédents (= 3-en-4)
}

/** Date du jour en heure de l'Est (les gameDate NHL sont en ET). */
function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Jours de repos depuis le dernier match joué (via le calendrier de saison). */
export async function fetchTeamRestInfo(abbr: string): Promise<TeamRestInfo> {
  const upper = abbr.toUpperCase();
  const key   = `rest:${upper}:${todayET()}`;
  const cached = getCached<TeamRestInfo>(key);
  if (cached) return cached;

  const fallback: TeamRestInfo = { restDays: 2, b2b: 0, dense3in4: 0 };
  try {
    const data  = await fetchNHL<any>(`v1/club-schedule-season/${upper}/now`);
    const today = todayET();
    const played = (data.games ?? [])
      .filter((g: any) =>
        g.gameType === 2 &&
        ['OFF', 'FINAL', 'OVER'].includes(g.gameState) &&
        (g.gameDate ?? '') < today
      )
      .map((g: any) => g.gameDate as string)
      .sort();

    if (!played.length) return fallback;

    const now      = new Date(today + 'T12:00:00');
    const lastDate = new Date(played[played.length - 1] + 'T12:00:00');
    const days     = Math.round((now.getTime() - lastDate.getTime()) / 86_400_000);
    // 3-en-4 : matchs joués dans les 3 jours précédents (même déf. que build_dataset).
    const dense3in4 = played.filter((d: string) => {
      const diff = Math.round((now.getTime() - new Date(d + 'T12:00:00').getTime()) / 86_400_000);
      return diff >= 1 && diff <= 3;
    }).length;
    const info: TeamRestInfo = {
      restDays: Math.min(Math.max(days, 0), 7),
      b2b:      days === 1 ? 1 : 0,
      dense3in4,
    };
    setCached(key, info, 6 * 60 * 60_000);   // cache 6 h
    return info;
  } catch {
    return fallback;
  }
}

// --- Voyage / fuseaux / altitude / road-trip --------------------------------

/**
 * Features voyage/calendrier d'une équipe pour un match à jouer dans l'aréna
 * `venueAbbr` (= équipe à domicile du match). Reconstruit la séquence de la
 * saison (matchs joués + à venir) depuis club-schedule-season et applique la
 * logique PURE de travel.ts — identique à build_dataset.py::add_travel.
 * Renvoie null si le calendrier est indisponible (l'appelant met des neutres).
 */
export async function fetchTeamTravel(
  abbr: string,
  venueAbbr: string,
): Promise<TravelFeatures | null> {
  const team  = abbr.toUpperCase();
  const venue = venueAbbr.toUpperCase();
  const key   = `travel:${team}:${venue}:${todayET()}`;
  const cached = getCached<TravelFeatures>(key);
  if (cached) return cached;

  try {
    const data  = await fetchNHL<any>(`v1/club-schedule-season/${team}/now`);
    const today = todayET();
    const games = (data.games ?? [])
      .filter((g: any) => g.gameType === 2 && g.gameDate)   // saison régulière
      .map((g: any) => ({
        date:     g.gameDate as string,
        homeAbbr: (g.homeTeam?.abbrev ?? '').toUpperCase(),
        state:    g.gameState as string,
      }))
      .sort((a: any, b: any) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    if (!games.length) return null;

    const seq: TravelGame[] = games.map((g: any) => ({
      date: g.date, venueAbbr: g.homeAbbr, isHome: g.homeAbbr === team,
    }));

    // Match courant = prochain match non terminé disputé dans cet aréna.
    let idx = games.findIndex(
      (g: any) => g.homeAbbr === venue &&
        !['OFF', 'FINAL', 'OVER'].includes(g.state) && g.date >= today,
    );
    if (idx < 0) idx = games.findIndex((g: any) => g.homeAbbr === venue && g.date >= today);
    if (idx < 0) return null;

    const info = computeTravel(seq, idx);
    setCached(key, info, 6 * 60 * 60_000);   // cache 6 h
    return info;
  } catch {
    return null;
  }
}
