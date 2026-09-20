// ─── NHL API Types ────────────────────────────────────────────────────────────

export interface NHLTeamInfo {
  id: number;
  name: string;
  abbreviation: string;
  city: string;
  conference: string;
  division: string;
  logoUrl?: string;
}

export interface NHLTeamStats {
  teamId: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  otLosses: number;
  points: number;
  goalsFor: number;
  goalsAgainst: number;
  goalsForPerGame: number;
  goalsAgainstPerGame: number;
  powerPlayPct: number;
  penaltyKillPct: number;
  shotsForPerGame: number;
  shotsAgainstPerGame: number;
  faceoffWinPct: number;
  homeRecord: string;
  awayRecord: string;
  last10: string;
  streak: string;
}

export interface NHLGame {
  id: string;
  gameDate: string;
  startTime: string;
  /**
   * Mise au jeu en ISO/UTC — le serveur l'envoie depuis toujours
   * (`teamsAndGames.ts`), le type ne la déclarait pas. `startTime` est déjà
   * localisée et ne se trie pas ; c'est ce champ-ci qui sert de clé de tri.
   */
  startTimeUTC?: string | null;
  status: "scheduled" | "live" | "final";
  period?: number;
  clock?: string;
  homeTeam: {
    id: number;
    abbreviation: string;
    name: string;
    score?: number;
  };
  awayTeam: {
    id: number;
    abbreviation: string;
    name: string;
    score?: number;
  };
  venue: string;
  gameType: "regular" | "playoff";
}

export interface NHLPlayerInfo {
  id: number;
  /** Full display name as returned by the API (e.g. "Connor McDavid"). */
  name: string;
  /** Sweater number as returned by the API. */
  number: number;
  teamId: number;
  teamAbbr: string;
  position: string;
  imageUrl?: string;
  // Legacy/alternate field names kept optional for backward compatibility.
  firstName?: string;
  lastName?: string;
  fullName?: string;
  jerseyNumber?: number;
}

export interface NHLPlayerStats {
  playerId: number;
  season: string;
  gamesPlayed: number;
  goals: number;
  assists: number;
  points: number;
  plusMinus: number;
  shots: number;
  shootingPct: number;
  powerPlayGoals: number;
  powerPlayPoints: number;
  shortHandedGoals: number;
  penaltyMinutes: number;
  blockedShots: number;
  hits: number;
  timeOnIce: number; // minutes per game
  faceoffWinPct?: number;
  // Goalie specific
  savePct?: number;
  savesPerGame?: number;
  goalsAgainstAvg?: number;
}

export interface NHLStandings {
  conference: string;
  division: string;
  teams: {
    rank: number;
    team: NHLTeamInfo;
    stats: NHLTeamStats;
  }[];
}

// ─── Prediction API Types ─────────────────────────────────────────────────────

export type BetMarketType =
  // ── NHL: Game markets ─────────────────────────────────────────────────────
  | "moneyline"
  | "puck_line"
  | "total_goals"
  | "regulation_result"
  | "game_to_ot"
  | "both_teams_score"
  | "winning_margin"
  | "alt_puck_line"          // Alternate puck lines (-2.5 / +2.5)
  | "ot_winner"              // Winner IF the game goes to OT (conditional)
  | "ot_so_winner"           // Wins in OT/SO — unconditional (Match Betting tile)
  // ── NHL: Period markets ───────────────────────────────────────────────────
  | "period1_winner"
  | "period2_winner"
  | "period3_winner"
  | "highest_scoring_period"
  | "period1_total_goals"    // O/U goals in 1st period
  | "period2_total_goals"    // O/U goals in 2nd period
  | "period3_total_goals"    // O/U goals in 3rd period
  // ── NHL: Team markets ─────────────────────────────────────────────────────
  | "first_team_score"
  | "last_team_score"        // Which team scores the last goal
  | "team_total_goals"
  | "team_pp_goals"
  | "team_penalty_kill"
  | "clean_sheet"            // Team doesn't concede
  | "team_score_every_period"// Team scores in every period
  | "total_penalties"        // Total penalty minutes O/U
  // ── NHL: Player markets ───────────────────────────────────────────────────
  | "anytime_goal"
  | "first_goal_scorer"
  | "last_goal_scorer"       // Player scores the last goal
  | "shots_ou"
  | "assists_ou"
  | "points_ou"
  | "pp_point"
  | "goalie_saves_ou"
  | "penalty_minutes_ou"
  | "blocked_shots_ou"
  | "time_on_ice_ou"
  | "faceoff_wins_ou"
  | "hits_ou";

export interface PredictionRequest {
  marketType: BetMarketType;
  gameId?: string;
  teamId?: string;
  opponentId?: string;
  isHome?: boolean;
  playerId?: string;
  line?: number; // For O/U markets (e.g. 3.5 shots)
  selection?: string; // "over" | "under" | "home" | "away" | team abbr
  period?: 1 | 2 | 3;
  seasonContext?: {
    lastNGames?: number;
  };
}

export interface PredictionFactor {
  label: string;
  description: string;
  weight: number; // 0-100 how much it influences the prediction
  value: string;
  impact: "positive" | "negative" | "neutral";
}

/**
 * Réserve attachée à une probabilité : le chiffre est calculé, mais il y a
 * quelque chose que l'utilisateur ne peut pas deviner en le regardant.
 * Traduites par les clés `ml.caveat.*`. Voir `PredictionCaveat` côté serveur
 * (`routes/ml.routes.ts`) — les deux unions doivent bouger ensemble.
 */
export type PredictionCaveat =
  | "league_average"
  | "shared_with_first_goal"
  | "period_symmetric";

export interface PredictionResponse {
  probability: number; // 0-100
  confidence: "very_low" | "low" | "medium" | "high" | "very_high";
  factors: PredictionFactor[];
  /** Présent seulement quand il y a une réserve à afficher AVEC le chiffre. */
  caveat?: PredictionCaveat;
  modelVersion: string;
  generatedAt: string;
  disclaimer?: string;
}

export interface ParlayPredictionRequest {
  legs: {
    marketType: BetMarketType;
    probability: number;
    /** Match concerné — sans lui, deux jambes du même match sont indiscernables. */
    gameId?: string;
    /** 'over' | 'under' | 'yes' | 'no' | abréviation d'équipe | seau d'écart. */
    selectionValue?: string;
    line?: number;
    // `correlation` a été retiré : le champ était envoyé, jamais lu, et servait
    // d'alibi à une docstring qui promettait une gestion des corrélations
    // inexistante. La corrélation se déduit de l'identité des jambes.
  }[];
}

export interface ParlayPredictionResponse {
  /** `null` si une jambe porte une probabilité illisible. */
  combinedProbability: number | null;
  /** Égal à `combinedProbability` — l'abattement forfaitaire de 0,95 a disparu. */
  adjustedProbability: number | null;
  /** Vrai si deux jambes s'excluent : la combinaison vaut 0. */
  impossible?: boolean;
  /** Jambes retirées parce que dupliquées ou impliquées par une autre. */
  redundantLegs?: number;
  /** Vrai si des jambes partagent un match sans relation logique connue. */
  assumesIndependence?: boolean;
  legs: {
    marketType: BetMarketType;
    probability: number;
    contribution: number; // How much this leg impacts the parlay
  }[];
}

// ─── Bet Slip Types ───────────────────────────────────────────────────────────

export interface BetLeg {
  id: string;
  marketType: BetMarketType;
  marketLabel: string;
  subjectType: "team" | "player" | "game";
  subjectId: string;
  subjectName: string;
  subjectLogo: string;
  selection: string; // Human readable: "Boston Bruins to win", "Over 5.5 goals"
  selectionShort: string;
  probability: number; // 0-100
  oddsLabel?: string; // American odds display, e.g. "-150" / "+120"
  line?: number; // For O/U markets (e.g. 3.5 shots)
  gameInfo?: string; // Human readable context: "BOS vs NYR · 7:00 PM ET"
  addedAt: string; // ISO timestamp
  // Machine-readable fields — required for automatic settlement
  // (see server/src/services/settlement.service.ts). Optional because not
  // every market can be safely auto-settled (e.g. faceoff_wins_ou).
  gameId?: string;
  /** 'over' | 'under' | 'yes' | team abbreviation, depending on the market. */
  selectionValue?: string;
  /**
   * Adversaire et côté de la glace.
   *
   * Servent à UNE chose : construire la loi jointe des scores du match quand le
   * coupon porte plusieurs jambes dessus, et chiffrer leur corrélation au lieu
   * de la supposer nulle. Sans l'adversaire, le serveur ne peut pas savoir de
   * quel match il s'agit et retombe sur le produit.
   */
  opponentId?: string;
  isHome?: boolean;
}