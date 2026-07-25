/**
 * NHL API Service
 * Base URL: VITE_NHL_API_URL = http://localhost:3001/api/nhl
 */

import type {
  NHLGame,
  NHLTeamInfo,
  NHLTeamStats,
  NHLPlayerInfo,
  NHLPlayerStats,
  NHLStandings,
} from '../types/bet';

import { weightsQuery } from './ruleWeightsService';

const BASE_URL = import.meta.env.VITE_NHL_API_URL || '';

// ── Bet365-style charts (per-player, last 6 seasons) ────────────────────────
export interface PlayerSeasonStat {
  seasonId: number;
  gp: number;
  // Skater
  goals?: number; assists?: number; points?: number;
  plusMinus?: number; shots?: number; ppPoints?: number; shootingPct?: number;
  // Goalie
  wins?: number; shutouts?: number; savePct?: number | null; gaa?: number | null;
}
export interface PlayerSeasons {
  id: string;
  name: string;
  position: string;
  number: number;
  seasons: PlayerSeasonStat[];
}
export interface TeamPlayerSeasons {
  teamAbbr: string;
  seasonIds: number[];
  skaters: PlayerSeasons[];
  goalies: PlayerSeasons[];
}

// Per-opponent splits (avg-per-game-vs-team column). `vs` maps opponent abbr →
// summed counting stats for that season; divide by `gp` for the average.
export interface OpponentSplit {
  gp: number;
  goals?: number; assists?: number; points?: number;
  plusMinus?: number; shots?: number; ppPoints?: number;
  wins?: number; shutouts?: number; saves?: number;
  shotsAgainst?: number; goalsAgainst?: number;
}
// One chronological per-game entry (for the line chart).
export interface SeriesGame {
  goals?: number; assists?: number; points?: number;
  plusMinus?: number; shots?: number; ppPoints?: number;
  wins?: number; shutouts?: number; saves?: number;
  shotsAgainst?: number; goalsAgainst?: number; savePct?: number | null;
}
export interface PlayerOpponentSplits {
  id: string;
  vs: Record<string, OpponentSplit>;
  series: SeriesGame[];
}
export interface TeamOpponentSplits {
  teamAbbr: string;
  season: number;
  opponents: string[];
  skaters: PlayerOpponentSplits[];
  goalies: PlayerOpponentSplits[];
}

export interface TeamOfficialStats {
  gamesPlayed: number;
  wins: number; losses: number; points: number;
  goalsFor: number; goalsAgainst: number;
  goalsForPerGame: number; goalsAgainstPerGame: number;
  ppPct: number; pkPct: number; pointPct: number; faceoffPct: number;
  shotsForPerGame: number; shotsAgainstPerGame: number;
}
export interface TeamVsOpponent {
  gp: number; goalsFor: number; goalsAgainst: number;
  wins: number; losses: number; otLosses: number;
}
export interface RecordSplit { w: number; l: number; otl: number; }
export interface TeamRecord {
  overall: RecordSplit;
  home: RecordSplit;
  away: RecordSplit;
  last10: RecordSplit;
  oneGoal: RecordSplit;
  streak: string;
}
export interface TeamSeasonOfficial {
  teamAbbr: string;
  season: number;
  official: TeamOfficialStats | null;
  vsOpponent: Record<string, TeamVsOpponent>;
  record: TeamRecord | null;
}

async function get<T>(path: string): Promise<T> {
  if (!BASE_URL) throw new Error('VITE_NHL_API_URL is not configured');
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`NHL API ${res.status}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

export const nhlApiService = {
  getGamesByDate: (date?: string): Promise<NHLGame[]> => {
    const d = date || new Date().toISOString().split('T')[0];
    return get<NHLGame[]>(`/games?date=${d}`);
  },

  // Calendrier : tous les matchs entre deux dates (YYYY-MM-DD) incluses.
  getGamesRange: (start: string, end: string): Promise<NHLGame[]> =>
    get<NHLGame[]>(`/games/range?start=${start}&end=${end}`),

  // Calendrier : date courante + bornes de saison selon l'API NHL.
  getScheduleAnchor: (): Promise<{ today: string; seasonStart: string; seasonEnd: string }> =>
    get<{ today: string; seasonStart: string; seasonEnd: string }>('/schedule/anchor'),

  getLiveGames: (): Promise<NHLGame[]> =>
    get<NHLGame[]>('/games/live'),

  getGame: (gameId: string): Promise<NHLGame> =>
    get<NHLGame>(`/games/${gameId}`),

  getAllTeams: (): Promise<NHLTeamInfo[]> =>
    get<NHLTeamInfo[]>('/teams'),

  getTeamStats: (teamId: string): Promise<NHLTeamStats> =>
    get<NHLTeamStats>(`/teams/${teamId}/stats`),

  getTeamLastNGamesStats: (teamId: string, n: number): Promise<NHLTeamStats> =>
    get<NHLTeamStats>(`/teams/${teamId}/last/${n}`),

  getTeamRoster: (abbr: string): Promise<NHLPlayerInfo[]> =>
    get<NHLPlayerInfo[]>(`/teams/${abbr}/roster`),

  // Bet365-style charts — last 6 seasons of per-player stats (skaters + goalies).
  getTeamPlayerSeasons: (abbr: string): Promise<TeamPlayerSeasons> =>
    get<TeamPlayerSeasons>(`/teams/${abbr}/player-seasons`),

  // Charts — per-opponent player splits for a season (avg-per-game-vs-team).
  getTeamOpponentSplits: (abbr: string, season: number | string): Promise<TeamOpponentSplits> =>
    get<TeamOpponentSplits>(`/teams/${abbr}/opponent-splits/${season}`),

  // Charts — official team stats for a season + per-opponent GF/GA/W.
  getTeamSeasonOfficial: (abbr: string, season: number | string): Promise<TeamSeasonOfficial> =>
    get<TeamSeasonOfficial>(`/teams/${abbr}/season-official/${season}`),

  searchPlayers: (query: string): Promise<NHLPlayerInfo[]> =>
    get<NHLPlayerInfo[]>(`/players/search?q=${encodeURIComponent(query)}`),

  getAllPlayers: (): Promise<NHLPlayerInfo[]> =>
    get<NHLPlayerInfo[]>('/players'),

  getPlayer: (playerId: string): Promise<NHLPlayerInfo> =>
    get<NHLPlayerInfo>(`/players/${playerId}`),

  getPlayerStats: (playerId: string): Promise<NHLPlayerStats> =>
    get<NHLPlayerStats>(`/players/${playerId}/stats`),

  getStandings: (): Promise<NHLStandings[]> =>
    get<NHLStandings[]>('/standings'),

  // ── Predictions (rule-based market groups from backend) ──────────────────
  getGamePredictions:   (gameId: string)   => get<any[]>(`/predictions/game/${gameId}${weightsQuery()}`),
  getTeamPredictions:   (teamAbbr: string) => get<any[]>(`/predictions/team/${teamAbbr}`),
  getPlayerPredictions: (playerId: string) => get<any[]>(`/predictions/player/${playerId}`),
};
