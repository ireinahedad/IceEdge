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
