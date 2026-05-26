// ─────────────────────────────────────────────────────────────
// CORE GAME TYPES
// ─────────────────────────────────────────────────────────────

export type GameStatus = "scheduled" | "live" | "finished";

export interface NHLTeam {
  id: number;
  name: string;
  abbreviation: string;
  score?: number;
}

export interface NHLGame {
  id: string;
  gameDate: string;        // YYYY-MM-DD
  startTime: string;       // "7:00 PM ET"
  status: GameStatus;

  period?: number;
  clock?: string;

  homeTeam: NHLTeam;
  awayTeam: NHLTeam;

  venue?: string;
  gameType?: "regular" | "playoff";
}

// ─────────────────────────────────────────────────────────────
// TEAM TYPES
// ─────────────────────────────────────────────────────────────

export interface NHLTeamInfo {
  id: number;
  name: string;
  abbreviation: string;
  city: string;
  conference: "Eastern" | "Western";
  division: string;
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

// ─────────────────────────────────────────────────────────────
// PLAYER TYPES
// ─────────────────────────────────────────────────────────────

export interface NHLPlayerInfo {
  id: number;

  firstName: string;
  lastName: string;
  fullName: string;

  teamId: number;
  teamAbbr: string;

  position: string;
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

  timeOnIce: number; // avg per game in minutes

  faceoffWinPct?: number;
}

// ─────────────────────────────────────────────────────────────
// STANDINGS
// ─────────────────────────────────────────────────────────────

export interface NHLStandings {
  teamId: number;
  teamName: string;
  conference: "Eastern" | "Western";
  division: string;

  gamesPlayed: number;
  wins: number;
  losses: number;
  otLosses: number;

  points: number;

  goalDifferential: number;
}

// ─────────────────────────────────────────────────────────────
// ODDS + BETTING TYPES (IMPORTANT FOR MVP)
// ─────────────────────────────────────────────────────────────

export interface Odds {
  id?: string;

  gameId: string;

  bookmaker: string;

  market: "moneyline" | "spread" | "total" | "player_prop";

  selection: string;

  odds: number; // American or decimal normalized

  timestamp?: string;
}

// ─────────────────────────────────────────────────────────────
// ML + PREDICTION TYPES
// ─────────────────────────────────────────────────────────────

export interface Prediction {
  gameId: string;

  homeWinProb: number;
  awayWinProb: number;

  confidence: number;
}

// ─────────────────────────────────────────────────────────────
// OPPORTUNITY / EV ENGINE (CORE MVP OUTPUT)
// ─────────────────────────────────────────────────────────────

export interface BetOpportunity {
  gameId: string;

  bookmaker: string;

  market: string;
  selection: string;

  odds: number;

  modelProb: number;
  impliedProb: number;

  edge: number;
  ev: number;

  confidence: number;

  reasoning: string[];
}

// ─────────────────────────────────────────────────────────────
// OPTIONAL: INTERNAL ML FEATURES (FUTURE USE)
// ─────────────────────────────────────────────────────────────

export interface MLFeatures {
  homeTeamStrength: number;
  awayTeamStrength: number;

  homeGoalsPerGame: number;
  awayGoalsPerGame: number;

  restAdvantage: number;

  homeAdvantage: number;

  recentFormDiff: number;
}