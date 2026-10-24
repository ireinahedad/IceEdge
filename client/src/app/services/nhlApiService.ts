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
  /** CF% / FF% de l'équipe quand il est sur la glace, 5 c. 5 (0–100, MoneyPuck). */
  onIceCorsiPct?: number | null; onIceFenwickPct?: number | null;
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
    /** k propre à ce joueur (dispersion par profil) — prime sur `modelDispersion`. */
    modelK?: Partial<Record<RateStat, number | null>>;
    /** Pénalités en nombre : [P(PIM ≥ 1), …, P(PIM ≥ 15)] — prime sur la binomiale négative. */
    pimLadder?: number[];
    /** Loi composée des pénalités pour le direct : nombre ~ BN(mu·f, k·f), durées `dur` de probabilités `mix`. */
    pimParams?: { mu: number; k: number | null; dur: number[]; mix: number[] };
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
  /**
   * Match commencé (serveur, `boxscoreLiveInfo`) : part des buts du match qui
   * reste à jouer (`f`, `null` en prolongation), et premier buteur. Absent =
   * état du match illisible — la grille affiche « — », pas la saison.
   * `fTeam` (par abréviation d'équipe) : même part, avec les effets de score
   * mesurés — pour les buts, passes et points seulement.
   */
  live?: { f: number | null; fTeam?: Record<string, number>; label: string; firstScorerId: string | null };
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
  /** Corsi % / Fenwick % à 5 c. 5 (0–100, MoneyPuck) ; null = pas de donnée. */
  corsiPct5v5?: number | null; fenwickPct5v5?: number | null;
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
  corsiPct5v5?: number | null; fenwickPct5v5?: number | null;
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
/** Une rencontre jouée entre deux clubs (face-à-face d'une saison). */
export interface HeadToHeadSeasonGame {
  gameId: string;
  date: string;
  homeAbbr: string;
  awayAbbr: string;
  homeScore: number;
  awayScore: number;
  /** 2 = saison régulière, 3 = séries. */
  gameType: 2 | 3;
  /** `REG` | `OT` | `SO`. */
  lastPeriodType: string;
}
export interface HeadToHeadSeason {
  /** Id NHL à 8 chiffres, ex. `20252026`. */
  season: string;
  games: HeadToHeadSeasonGame[];
}
export interface TeamSeasonOfficial {
  teamAbbr: string;
  season: number;
  official: TeamOfficialStats | null;
  vsOpponent: Record<string, TeamVsOpponent>;
  record: TeamRecord | null;
}

/**
 * En-têtes des GET. Seulement `Accept` : c'est un en-tête « simple » au sens
 * CORS. `Content-Type: application/json` — qu'un GET sans corps n'a aucune
 * raison d'envoyer — rendait chaque requête « non simple » : le navigateur
 * envoyait d'abord un OPTIONS (preflight) vers api.arakice.com, soit un
 * aller-retour de plus par appel. Mesuré en prod le 2026-10-23 : 756 ms avec,
 * 387 ms sans (PERF_PLAN.md, P0.1).
 */
const GET_HEADERS = { Accept: 'application/json' } as const;

/**
 * Préchargement (PERF_PLAN.md, P2.4). `primeGet` lance un GET AVANT que la page
 * qui en a besoin soit montée — `main.tsx` le fait pour l'accueil, avant même le
 * premier rendu React. Le premier `get` du même chemin reprend cette requête au
 * lieu d'en lancer une seconde. Une seule reprise, et seulement dans les
 * `PRIME_TTL_MS` : passé ce délai, ou pour un second lecteur, on redemande (et
 * le cache HTTP du navigateur répond s'il le peut).
 */
const PRIME_TTL_MS = 15_000;
const primed = new Map<string, { at: number; promise: Promise<unknown> }>();

export function primeGet(path: string): void {
  if (primed.has(path)) return;
  const promise = rawGet<unknown>(path);
  promise.catch(() => { /* le lecteur verra l'erreur ; ici, rien */ });
  primed.set(path, { at: Date.now(), promise });
}

function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const hit = primed.get(path);
  if (hit) {
    primed.delete(path);
    if (!signal && Date.now() - hit.at < PRIME_TTL_MS) return hit.promise as Promise<T>;
  }
  return rawGet<T>(path, signal);
}

async function rawGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (!BASE_URL) throw new Error('VITE_NHL_API_URL is not configured');
  const res = await fetchWithTimeout(`${BASE_URL}${path}`, {
    headers: GET_HEADERS,
    signal,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`NHL API ${res.status}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Comme `get`, mais refuse une réponse de REPLI (`X-Stale-Response`, posé par
 * `staleFallback` côté serveur quand l'amont est tombé). Pour un match en
 * cours, une vieille réponse est un score dépassé : l'appelant doit le savoir
 * plutôt que l'afficher comme actuel.
 */
async function getFresh<T>(path: string): Promise<T> {
  if (!BASE_URL) throw new Error('VITE_NHL_API_URL is not configured');
  const res = await fetchWithTimeout(`${BASE_URL}${path}`, {
    headers: GET_HEADERS,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`NHL API ${res.status}: ${msg}`);
  }
  if (res.headers.get('X-Stale-Response')) throw new Error('NHL API: réponse de repli (données non à jour)');
  return res.json() as Promise<T>;
}

/**
 * GET partagé : les appels simultanés sur le même chemin attendent UNE requête,
 * et la réponse sert encore `memoMs` après son arrivée.
 *
 * Pourquoi : sur la page d'un match, les sept `PlayerPropGrid` demandent chacune
 * la feuille de match (toutes les 30 s en direct) et l'effectif — sept requêtes
 * identiques par tick et par visiteur. Leurs minuteurs restent alignés, puisque
 * toutes se résolvent sur la même promesse. Un échec n'est jamais mémorisé.
 */
const shared = new Map<string, { promise: Promise<unknown>; until: number }>();
function sharedGet<T>(path: string, memoMs: number): Promise<T> {
  const now = Date.now();
  for (const [k, e] of shared) if (e.until < now) shared.delete(k);
  const hit = shared.get(path);
  if (hit) return hit.promise as Promise<T>;
  const promise = get<T>(path);
  // En vol : jamais expiré tant qu'elle n'a pas répondu.
  const entry = { promise, until: Infinity };
  shared.set(path, entry);
  promise.then(
    () => { entry.until = Date.now() + memoMs; },
    () => { if (shared.get(path) === entry) shared.delete(path); },
  );
  return promise;
}

/**
 * Recherche « Passé » (Stats › Tous les matchs). Les critères bornent le
 * résultat : `day` = un jour pour toute la ligue ; avec une équipe, `month`,
 * `playoffs` ou `opp` (un adversaire).
 */
export type PastScope = "day" | "month" | "playoffs" | "opp";
export interface PastGamesQuery {
  season: string;
  scope: PastScope;
  date?: string;
  team?: string;
  month?: string;
  opp?: string;
  venue?: "home" | "away";
  result?: "W" | "L";
  decision?: "REG" | "OT" | "SO";
}
export interface PastGamesPage {
  season: string;
  games: NHLGame[];
  /** Recherche par jour : soirée NHL la plus proche avant / après (ou null). */
  prevDay?: string | null;
  nextDay?: string | null;
}

/** Chemin de `getGamesRange` — exporté pour que le préchargement demande la même URL. */
export const gamesRangePath = (start: string, end: string) => `/games/range?start=${start}&end=${end}`;

export const nhlApiService = {
  getGamesByDate: (date?: string): Promise<NHLGame[]> => {
    const d = date || new Date().toISOString().split('T')[0];
    return get<NHLGame[]>(`/games?date=${d}`);
  },

  // Calendrier : tous les matchs entre deux dates (YYYY-MM-DD) incluses.
  getGamesRange: (start: string, end: string): Promise<NHLGame[]> =>
    get<NHLGame[]>(gamesRangePath(start, end)),

  /** Matchs JOUÉS selon les critères, du plus récent au plus ancien. */
  getPastGames: (q: PastGamesQuery, signal?: AbortSignal): Promise<PastGamesPage> => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v != null && v !== "") qs.set(k, String(v));
    return get<PastGamesPage>(`/games/past?${qs.toString()}`, signal);
  },

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
  // Partagée entre les grilles de la page (5 s : bien sous le rappel de 30 s).
  getGameBoxscore: (gameId: string): Promise<GameBoxscoreResponse> =>
    sharedGet<GameBoxscoreResponse>(`/games/${gameId}/boxscore`, 5_000),

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

  // Partagé entre les grilles ; un effectif ne bouge pas en cours de page.
  getTeamRoster: (abbr: string): Promise<NHLPlayerInfo[]> =>
    sharedGet<NHLPlayerInfo[]>(`/teams/${abbr}/roster`, 5 * 60_000),

  // Bet365-style charts — last 6 seasons of per-player stats (skaters + goalies).
  getTeamPlayerSeasons: (abbr: string): Promise<TeamPlayerSeasons> =>
    get<TeamPlayerSeasons>(`/teams/${abbr}/player-seasons`),

  // Charts — per-opponent player splits for a season (avg-per-game-vs-team).
  getTeamOpponentSplits: (abbr: string, season: number | string): Promise<TeamOpponentSplits> =>
    get<TeamOpponentSplits>(`/teams/${abbr}/opponent-splits/${season}`),

  // Charts — official team stats for a season + per-opponent GF/GA/W.
  getTeamSeasonOfficial: (abbr: string, season: number | string): Promise<TeamSeasonOfficial> =>
    get<TeamSeasonOfficial>(`/teams/${abbr}/season-official/${season}`),

  /**
   * Toutes les rencontres jouées entre deux clubs sur une saison (régulière +
   * séries). `season` : id à 8 chiffres, `"current"` ou `"previous"` (résolus
   * par le serveur).
   */
  getHeadToHeadSeason: (abbr: string, opp: string, season: string): Promise<HeadToHeadSeason> =>
    get<HeadToHeadSeason>(`/teams/${encodeURIComponent(abbr)}/head-to-head/${encodeURIComponent(opp)}/${encodeURIComponent(season)}`),

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
  /** `live` : match en cours — une réponse de repli est refusée (voir `getFresh`). */
  getGamePredictions:   (gameId: string, live = false) =>
    (live ? getFresh : get)<any[]>(`/predictions/game/${gameId}${weightsQuery()}`),
  getTeamPredictions:   (teamAbbr: string) => get<any[]>(`/predictions/team/${teamAbbr}`),
  getPlayerPredictions: (playerId: string) => get<any[]>(`/predictions/player/${playerId}`),
};
