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
  firstName: string;
  lastName: string;
  fullName: string;
  teamId: number;
  teamAbbr: string;
  position: string;
  jerseyNumber: number;
  imageUrl?: string;
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
  | "double_chance"          // Home/Draw or Away/Draw (bet365)
  | "alt_puck_line"          // Alternate puck lines (-2.5 / +2.5)
  | "ot_winner"              // Winner if game goes to OT
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
  | "hits_ou"
  // ── Tennis markets ────────────────────────────────────────────────────────
  | "tennis_match_winner"
  | "tennis_total_sets"
  | "tennis_first_set"
  | "tennis_set_handicap"    // Set handicap (-1.5 / +1.5 sets)
  | "tennis_total_games"     // Total games O/U in match
  | "tennis_game_handicap"   // Game handicap
  | "tennis_correct_score"   // Correct score in sets (2-0, 2-1, etc.)
  | "tennis_to_win_set"      // Player wins at least one set
  | "tennis_tiebreak"        // Will there be a tiebreak?
  | "tennis_first_set_games";// O/U games in first set

export interface PredictionRequest {
  marketType: BetMarketType;
  gameId?: string;
  teamId?: string;
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

export interface PredictionResponse {
  probability: number; // 0-100
  confidence: "very_low" | "low" | "medium" | "high" | "very_high";
  factors: PredictionFactor[];
  modelVersion: string;
  generatedAt: string;
  disclaimer?: string;
}

export interface ParlayPredictionRequest {
  legs: {
    marketType: BetMarketType;
    probability: number;
    correlation?: number; // Some bets are correlated (not independent)
  }[];
}

export interface ParlayPredictionResponse {
  combinedProbability: number;
  adjustedProbability: number; // Accounts for correlations between legs
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
  selection: string; // Human readable: "Bost