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
import { env } from '../env';
import { fetchWithTimeout } from './http';

const BASE_URL = env.nhlApiUrl;

// ── Bet365-style charts (per-player, last 6 seasons) ────────────────────────
export interface PlayerSeasonStat {
  seasonId: number;
  gp: number;
  // Skater
  goals?: number; assists?: number; points?: number;
  plusMinus?: number; shots?: number; ppPoints?: number; shootingPct?: number;
  pim?: number; powerPlayGoals?: number; shorthandedPoints?: number;
  faceoffPct?: number | null; avgToi?: number | null;
  // Goalie
  wins?: number; shutouts?: number; savePct?: number | null; gaa?: number | null;
  losses?: number; otLosses?: number;
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
  // Only populated by the leader-series endpoint (the team opponent-splits
  // series omits these, which is why the metrics reading them fall back to null).
  pim?: number; powerPlayGoals?: number; shorthandedPoints?: number;
  losses?: number; otLosses?: number;
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

// League leaders (All Players charts page) — one full stat line per player,
// already sorted by the requested metric.
export interface PlayerLeader {
  id: string;
  name: string;
  teamAbbr: string;
  position: string;
  stat: PlayerSeasonStat;
}
export interface PlayerLeaders {
  season: number;
  view: 'skater' | 'goalie';
  sort: string;
  players: PlayerLeader[];
}

// ── Feuille de match en direct ──────────────────────────────────────────────
/** Ce qu'un joueur a accumulé DANS CE MATCH — pas sur la saison. */
export interface BoxscoreLine {
  playerId: string;
  goals: number; assists: number; points: number; shots: number;
  hits: number; blockedShots: number; pim: number; toi: number;
  /** Gardiens seulement. */
  saves?: number; shotsAgainst?: number; goalsAgainst?: number; decision?: string;
}
export type RateStat = "goals" | "assists" | "points" | "shots" | "hits" | "blocks" | "saves" | "pim" | "ppPoints";
export interface PlayerRatesResponse {
  gameId?: string;
  /** `k` de la binomiale négative par statistique ; `null` = Poisson. */
  dispersion: Record<RateStat, number | null>;
  /** k du modèle joueur — pour les lignes `source: "model"`. `null` = Poisson. */
  modelDispersion?: Partial<Record<RateStat, number | null>>;
  /** Date des dernières données du modèle joueur. */
  modelAsOf?: string | null;
  players: Record<string, {
    /** `model` = modèle joueur (temps de glace, AN, coéquipiers, adversaire) ; `rules` = règle. */
    source?: "model" | "rules";
    team: string; position: "F" | "D" | "G"; gp: number;
    rates: Partial<Record<RateStat, number>>;
    /** P(ouvre le score), 0–1. */
    firstGoal?: number;
    /** Buts attendus dans le match, les deux équipes. */
    gameGoals?: number;
  }>;
}

export interface GameBoxscoreResponse {
  /** `unknown` = feuille indisponible (match à venir, amont muet, mode mock). */
  state: "scheduled" | "live" | "final" | "unknown";
  /** Indexé par identifiant de joueur. */
  players: Record<string, BoxscoreLine>;
}

// ── Single game detail (game charts page) ───────────────────────────────────
export interface GameSide {
  abbr: string; name: string; score: number | null; sog: number | null;
}
export interface GameTeamStats {
  sog: number | null; pim: number; hits: number; blockedShots: number;
  giveaways: number; takeaways: number; ppGoals: number;
}
export interface GameSkaterLine {
  id: string; name: string; number: number; position: string;
  goals: number; assists: number; points: number; plusMinus: number;
  sog: number; hits: number; blockedShots: number; pim: number;
  giveaways: number; takeaways: number; toi: string; toiMin: number;
}
export interface GameGoalieLine {
  id: string; name: string; number: number;
  saves: number; shotsAgainst: number; goalsAgainst: number;
  savePct: number | null; decision: string; starter: boolean; toi: string;
}
export interface GameGoal {
  period: string; time: string; teamAbbr: string; scorer: string;
  assists: string[]; strength: string; isHome: boolean;
  homeScore: number | null; awayScore: number | null;
}
export interface GameStar {
  star: number; id: string; name: string; teamAbbr: string;
  position: string; goals: number; assists: number; points: number;
}
export interface GameDetail {
  id: string;
  season: number | null;
  gameDate: string;
  startTimeUTC: string | null;
  venue: string;
  venueLocation: string;
  gameType: 'regular' | 'playoff';
  status: 'scheduled' | 'live' | 'final';
  period: number | null;
  periodType: string | null;
  clock: string | null;
  inIntermission: boolean;
  lastPeriodType: string | null;
  home: GameSide;
  away: GameSide;
  periods: { label: string; home: number; away: number }[];
  scoring: GameGoal[];
  threeStars: GameStar[];
  /** Null until the game has started (no boxscore yet). */
  teamStats: { home: GameTeamStats; away: GameTeamStats } | null;
  players: {
    home: { skaters: GameSkaterLine[]; goalies: GameGoalieLine[] };
    away: { skaters: GameSkaterLine[]; goalies: GameGoalieLine[] };
  } | null;
}

// One row per team for the All Teams page. All 32 arrive in a single call, so
// the client sorts them locally.
export interface TeamSeasonRow {
  abbr: string;
  name: string;
  gamesPlayed: number;
  wins: number; losses: number; otLosses: number; points: number;
  goalsFor: number; goalsAgainst: number; goalDiff: number;
  goalsForPerGame: number; goalsAgainstPerGame: number;
  shotsForPerGame: number; shotsAgainstPerGame: number;
  ppPct: number; pkPct: number; pointPct: number; faceoffPct: number;
  shutouts: number;
}
export interface AllTeamsSeason {
  season: number;
  teams: TeamSeasonRow[];
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

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (!BASE_URL) throw new Error('VITE_NHL_API_URL is not configured');
  const res = await fetchWithTimeout(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
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

  // Charts — full detail for one game (landing + boxscore merged).
  getGameDetail: (gameId: string): Promise<GameDetail> =>
    get<GameDetail>(`/games/${gameId}/detail`),

  getAllTeams: (): Promise<NHLTeamInfo[]> =>
    get<NHLTeamInfo[]>('/teams'),

  getTeamStats: (teamId: string): Promise<NHLTeamStats> =>
    get<NHLTeamStats>(`/teams/${teamId}/stats`),

  getTeamLastNGamesStats: (teamId: string, n: number): Promise<NHLTeamStats> =>
    get<NHLTeamStats>(`/teams/${teamId}/last/${n}`),

  /**
   * Feuille de match EN DIRECT — les compteurs de chaque joueur pour ce match.
   *
   * Sert les grilles de paris joueur pendant la partie. Le serveur cache 30 s
   * tant que le match est en cours, 6 h une fois terminé ; inutile d'ajouter un
   * cache ici, il masquerait la fraîcheur qu'on vient d'obtenir.
   */
  getGameBoxscore: (gameId: string): Promise<GameBoxscoreResponse> =>
    get<GameBoxscoreResponse>(`/games/${gameId}/boxscore`),

  /**
   * Cadences des paris joueur (mode ML), pour les deux alignements d'un match
   * ou pour un club seul. Une requête par page — voir `playerRates.ts`.
   */
  getPlayerRates: (scope: "game" | "team" | "player", id: string, gameId?: string): Promise<PlayerRatesResponse> =>
    get<PlayerRatesResponse>(`/predictions/player-rates/${scope}/${encodeURIComponent(id)}${
      gameId ? `?game=${encodeURIComponent(gameId)}` : ""}`),

  /** Gardiens partants saisis pour un match : `{ TOR: "Joseph Woll", MTL: null }`. */
  getStartingGoalies: (gameId: string): Promise<Record<string, string | null>> =>
    get<Record<string, string | null>>(`/games/${gameId}/starting-goalies`),

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

  // Charts — every team's season summary (All Teams page).
  getAllTeamsSeason: (season?: number | null): Promise<AllTeamsSeason> =>
    get<AllTeamsSeason>(`/teams/season-summary${season != null ? `?season=${season}` : ''}`),

  searchPlayers: (query: string): Promise<NHLPlayerInfo[]> =>
    get<NHLPlayerInfo[]>(`/players/search?q=${encodeURIComponent(query)}`),

  // Charts — league leaders for a season, sorted server-side by `sort`.
  // Omit `season` to get the current one (returned in the payload).
  getPlayerLeaders: (
    view: 'skater' | 'goalie',
    sort: string,
    limit = 20,
    season?: number | null,
    // Abandon par l'appelant (changement de tri avant la réponse) : remonte
    // en `AbortError`, jamais en `RequestTimeoutError` (voir `http.ts`).
    signal?: AbortSignal,
  ): Promise<PlayerLeaders> => {
    const q = new URLSearchParams({ view, sort, limit: String(limit) });
    if (season != null) q.set('season', String(season));
    return get<PlayerLeaders>(`/players/leaders?${q.toString()}`, signal);
  },

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
