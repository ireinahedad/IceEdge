/**
 * Prediction / ML Model API Service
 *
 * Configure your prediction server via environment variable:
 *   VITE_PREDICTION_API_URL=https://your-ml-server.com/api
 *
 * When not configured, probabilities are estimated from local stats data.
 * Replace mock logic with real ML model responses from your server.
 *
 * Expected server endpoints:
 *   POST /api/predict/single   → PredictionResponse
 *   POST /api/predict/parlay   → ParlayPredictionResponse
 *   GET  /api/predict/markets  → Available markets for a game/team/player
 *
 * Your ML model should accept:
 *   - marketType (the type of bet)
 *   - gameId / teamId / playerId
 *   - line (for over/under markets)
 *   - selection ("over" | "under" | team abbr etc.)
 *   - seasonContext (last N games filter, etc.)
 */

import type {
  PredictionRequest,
  PredictionResponse,
  ParlayPredictionRequest,
  ParlayPredictionResponse,
  BetMarketType,
} from "./../types/bet";



const BASE_URL = import.meta.env.VITE_PREDICTION_API_URL || "";

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

async function post<T>(path: string, body: unknown): Promise<T> {
  if (!BASE_URL) throw new Error("Prediction API not configured");
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Prediction API error ${res.status}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

async function get<T>(path: string): Promise<T> {
  if (!BASE_URL) throw new Error("Prediction API not configured");
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Prediction API error ${res.status}`);
  return res.json() as Promise<T>;
}

// ─── Prediction Service ───────────────────────────────────────────────────────

export const predictionApiService = {
  /**
   * Get win/hit probability for a single bet market.
   * Falls back to local estimation when API is not configured.
   */
  getSinglePrediction: async (
    req: PredictionRequest
  ): Promise<PredictionResponse> => {
    try {
      return await post<PredictionResponse>("/predict/single", req);
    } catch {
      return buildMockPrediction(req);
    }
  },

  /**
   * Get combined probability for a multi-leg parlay.
   * The ML model can account for correlated legs (e.g., same game bets).
   * Falls back to naive multiplication when API is not configured.
   */
  getParlayPrediction: async (
    req: ParlayPredictionRequest
  ): Promise<ParlayPredictionResponse> => {
    try {
      return await post<ParlayPredictionResponse>("/predict/parlay", req);
    } catch {
      // Naive: multiply all probabilities (assumes independence)
      const combined =
        req.legs.reduce((acc, leg) => acc * (leg.probability / 100), 1) * 100;

      return {
        combinedProbability: Math.round(combined * 10) / 10,
        adjustedProbability: Math.round(combined * 0.95 * 10) / 10, // slight haircut for corr
        legs: req.legs.map((leg) => ({
          marketType: leg.marketType,
          probability: leg.probability,
          contribution: Math.round(leg.probability),
        })),
      };
    }
  },

  /**
   * Get available prediction markets for a game.
   * Returns market types the ML model can predict.
   */
  getAvailableMarketsForGame: async (
    gameId: string
  ): Promise<BetMarketType[]> => {
    try {
      return await get<BetMarketType[]>(`/predict/markets/game/${gameId}`);
    } catch {
      return GAME_MARKET_TYPES;
    }
  },

  /**
   * Get available prediction markets for a player.
   */
  getAvailableMarketsForPlayer: async (
    playerId: string
  ): Promise<BetMarketType[]> => {
    try {
      return await get<BetMarketType[]>(`/predict/markets/player/${playerId}`);
    } catch {
      return PLAYER_MARKET_TYPES;
    }
  },
};


// ─── Factor / Waterfall types ─────────────────────────────────────────────────

export interface CalcFactor {
  icon: string;
  label: string;
  delta: number;
}

export interface FactorsResponse {
  basePct: number;
  factors: CalcFactor[];
  finalPct: number;
}

export interface PlayerPropRequest {
  playerId: string;
  playerName: string;
  propType: "goals" | "points" | "assists" | "award";
  line: number;
  season: string;
  currentGoals?: number;
  currentPoints?: number;
  currentAssists?: number;
  gamesPlayed?: number;
}

export interface PlayerPropResponse {
  probability: number;
  oddsLabel: string;
  factors: CalcFactor[];
  betNote: string;
}

export interface FuturesRequest {
  teamId: string;
  teamName: string;
  propType: "cup" | "conf";
  wins?: number;
  losses?: number;
  seriesContext?: string;
}

export interface FuturesResponse {
  probability: number;
  oddsLabel: string;
  factors: CalcFactor[];
  betNote: string;
}

// ─── Extended prediction service ──────────────────────────────────────────────

const PRED_BASE = () => import.meta.env.VITE_PREDICTION_API_URL || "";

async function tryPost<T>(path: string, body: unknown): Promise<T | null> {
  const base = PRED_BASE();
  if (!base) return null;
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json() as Promise<T>;
  } catch { /* fall through */ }
  return null;
}

export const factorsApiService = {
  /**
   * Waterfall breakdown explaining a prediction.
   * LLM endpoint: POST /api/predict/factors
   * Body:   { type, id, context }
   * Return: { basePct, factors: [{icon,label,delta}], finalPct }
   * Falls back to empty factors — caller builds from raw stats.
   */
  getFactors: async (
    type: "team" | "player" | "game" | "player-prop" | "future",
    id: string,
    context: Record<string, unknown> = {}
  ): Promise<FactorsResponse> => {
    const result = await tryPost<FactorsResponse>("/predict/factors", { type, id, context });
    return result ?? { basePct: 50, factors: [], finalPct: (context.fallbackPct as number) ?? 50 };
  },

  /**
   * Season prop probability for a player.
   * LLM endpoint: POST /api/predict/player-prop
   * Body:   { playerId, playerName, propType, line, season, currentGoals, gamesPlayed, … }
   * Return: { probability, oddsLabel, factors, betNote }
   */
  getPlayerProp: async (req: PlayerPropRequest): Promise<PlayerPropResponse> => {
    const result = await tryPost<PlayerPropResponse>("/predict/player-prop", req);
    return result ?? buildMockPlayerProp(req);
  },

  /**
   * Stanley Cup / conference futures probability.
   * LLM endpoint: POST /api/predict/futures
   * Body:   { teamId, teamName, propType, wins, losses, seriesContext }
   * Return: { probability, oddsLabel, factors, betNote }
   */
  getFutures: async (req: FuturesRequest): Promise<FuturesResponse> => {
    const result = await tryPost<FuturesResponse>("/predict/futures", req);
    return result ?? buildMockFutures(req);
  },
};

function probToOddsLabel(pct: number): string {
  const p = Math.max(5, Math.min(95, pct)) / 100;
  if (p >= 0.5) return `-${Math.round((p / (1 - p)) * 100)}`;
  return `+${Math.round(((1 - p) / p) * 100)}`;
}

function buildMockPlayerProp(req: PlayerPropRequest): PlayerPropResponse {
  const gp = req.gamesPlayed ?? 60;
  const remaining = Math.max(0, 82 - gp);
  const current =
    req.propType === "goals"   ? (req.currentGoals   ?? 0) :
    req.propType === "points"  ? (req.currentPoints  ?? 0) :
    req.propType === "assists" ? (req.currentAssists ?? 0) : 0;

  const pace = gp > 0 ? (current / gp) * 82 : current;
  const needed = req.line - current;
  const rateNeeded = remaining > 0 ? needed / remaining : Infinity;
  const currentRate = gp > 0 ? current / gp : 0;

  const probability =
    needed <= 0               ? 95 :
    rateNeeded <= currentRate * 0.85 ? 75 :
    rateNeeded <= currentRate        ? 62 :
    rateNeeded <= currentRate * 1.15 ? 45 : 28;

  const factors: CalcFactor[] = [
    { icon: "\u{1F4CA}", label: `Season pace: ${pace.toFixed(0)} (line: ${req.line})`, delta: pace >= req.line ? 12 : -8 },
    { icon: "\u{1F4C5}", label: `${remaining} games remaining, needs ${needed} more`, delta: remaining >= 20 ? 5 : remaining >= 10 ? 2 : -3 },
    { icon: "\u{1F4C8}", label: `Averaging ${currentRate.toFixed(2)} per game this season`, delta: currentRate >= rateNeeded ? 6 : -4 },
  ].filter(f => f.delta !== 0);

  const pct = Math.max(5, Math.min(95, probability));
  return {
    probability: pct,
    oddsLabel: probToOddsLabel(pct),
    factors,
    betNote: `${req.playerName} needs ${needed} more ${req.propType} in ${remaining} games (current pace: ${pace.toFixed(0)}). Connect POST /api/predict/player-prop for LLM-powered analysis.`,
  };
}

function buildMockFutures(req: FuturesRequest): FuturesResponse {
  const pct = req.propType === "cup" ? 33 : 50;
  return {
    probability: pct,
    oddsLabel: probToOddsLabel(pct),
    factors: [
      { icon: "\u{1F4CA}", label: `${req.wins ?? "?"} wins in current playoff run`, delta: 8 },
    ],
    betNote: `${req.teamName} futures. Connect POST /api/predict/futures for LLM-powered analysis.`,
  };
}


// ─── Mock Prediction Logic (fallback when API not connected) ──────────────────

function buildMockPrediction(req: PredictionRequest): PredictionResponse {
  const probability = estimateProbability(req);
  const confidence =
    probability >= 70
      ? "very_high"
      : probability >= 60
      ? "high"
      : probability >= 50
      ? "medium"
      : probability >= 40
      ? "low"
      : "very_low";

  return {
    probability,
    confidence,
    factors: buildMockFactors(req, probability),
    modelVersion: "mock-v1.0",
    generatedAt: new Date().toISOString(),
    disclaimer:
      "This is an estimated probability. Connect VITE_PREDICTION_API_URL for ML model predictions.",
  };
}

function estimateProbability(req: PredictionRequest): number {
  // ── These calculations will be replaced by your ML model ──
  const { marketType, line, selection } = req;

  const TEAM_WIN_RATES: Record<string, number> = {
    bos: 68, nyr: 61, tor: 59, mtl: 49, chi: 39,
    det: 46, vgk: 64, edm: 57, col: 66, fla: 62,
  };
  const PLAYER_GOALS_PER_GAME: Record<string, number> = {
    p1: 0.58, p2: 0.64, p3: 0.52, p4: 0.47, p5: 0.51, p6: 0.39, p7: 0.46, p8: 0.55,
    "8478402": 0.58, "8478483": 0.64, "8477493": 0.55, "8479318": 0.47, "8479420": 0.39, "8477934": 0.52,
  };

  const teamWin = TEAM_WIN_RATES[req.teamId || ""] ?? 52;
  const playerGoalRate = PLAYER_GOALS_PER_GAME[req.playerId || ""] ?? 0.35;

  switch (marketType) {
    case "moneyline": return teamWin;
    case "puck_line": return Math.max(18, teamWin - 22);
    case "total_goals":
      return selection === "over"
        ? line && line > 6 ? 42 : line && line < 5.5 ? 66 : 54
        : line && line > 6 ? 58 : line && line < 5.5 ? 34 : 46;
    case "regulation_result": return Math.max(30, teamWin - 10);
    case "period1_winner": return Math.max(28, teamWin - 15);
    case "period2_winner": return Math.max(28, teamWin - 14);
    case "period3_winner": return Math.max(28, teamWin - 13);
    case "game_to_ot": return 28;
    case "both_teams_score": return 74;
    case "winning_margin": return 12;
    case "first_team_score": return teamWin;
    case "team_total_goals":
      return selection === "over" ? (line && line <= 2.5 ? 68 : 48) : (line && line <= 2.5 ? 32 : 52);
    case "anytime_goal": return Math.round(playerGoalRate * 100);
    case "first_goal_scorer": return Math.round(playerGoalRate * 20);
    case "shots_ou":
      return selection === "over"
        ? line && line <= 2.5 ? 72 : line && line <= 3.5 ? 61 : 44
        : line && line <= 2.5 ? 28 : line && line <= 3.5 ? 39 : 56;
    case "assists_ou":
      return selection === "over"
        ? line && line <= 0.5 ? 58 : 34
        : line && line <= 0.5 ? 42 : 66;
    case "points_ou":
      return selection === "over"
        ? line && line <= 0.5 ? 65 : line && line <= 1.5 ? 44 : 28
        : line && line <= 0.5 ? 35 : line && line <= 1.5 ? 56 : 72;
    case "pp_point": return 32;
    case "goalie_saves_ou":
      return selection === "over" ? (line && line <= 25 ? 72 : 44) : (line && line <= 25 ? 28 : 56);
    case "penalty_minutes_ou": return selection === "over" ? 38 : 62;
    case "blocked_shots_ou": return selection === "over" ? 51 : 49;
    case "time_on_ice_ou": return selection === "over" ? 55 : 45;
    case "faceoff_wins_ou": return selection === "over" ? 52 : 48;
    case "hits_ou": return selection === "over" ? 48 : 52;
    default: return 50;
  }
}

function buildMockFactors(
  req: PredictionRequest,
  probability: number
): PredictionResponse["factors"] {
  return [
    {
      label: "Season Statistics",
      description: "Based on full season performance data",
      weight: 40,
      value: `${probability}% historical hit rate`,
      impact: probability >= 55 ? "positive" : probability >= 45 ? "neutral" : "negative",
    },
    {
      label: "Recent Form",
      description: "Performance trend over the last 10 games",
      weight: 25,
      value: "Trending " + (probability >= 55 ? "up" : "flat"),
      impact: probability >= 55 ? "positive" : "neutral",
    },
    {
      label: "Home/Away Split",
      description: "Performance at home vs. on the road",
      weight: 15,
      value: req.teamId ? "Home advantage factored in" : "Venue neutral",
      impact: "neutral",
    },
    {
      label: "Matchup History",
      description: "Head-to-head results this season",
      weight: 20,
      value: "2 games played this season",
      impact: "neutral",
    },
  ];
}

// ─── Available market types ───────────────────────────────────────────────────

const GAME_MARKET_TYPES: BetMarketType[] = [
  "moneyline", "puck_line", "total_goals", "regulation_result",
  "period1_winner", "period2_winner", "period3_winner",
  "game_to_ot", "both_teams_score", "winning_margin",
  "first_team_score", "team_total_goals", "highest_scoring_period",
];

const PLAYER_MARKET_TYPES: BetMarketType[] = [
  "anytime_goal", "first_goal_scorer", "shots_ou", "assists_ou",
  "points_ou", "pp_point", "goalie_saves_ou", "penalty_minutes_ou",
  "blocked_shots_ou", "time_on_ice_ou", "faceoff_wins_ou", "hits_ou",
];
