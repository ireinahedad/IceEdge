import { Router, Request, Response } from "express";
import {
  predictMoneyline,
  predictPuckLine,
  predictTotalGoals,
  predictAnytimeGoal,
  predictFirstGoalScorer,
  predictShotsOU,
  predictAssistsOU,
  predictPointsOU,
  predictPPPoint,
  predictPositionBasedProp,
  predictFutures,
  buildRealFactors,
} from "../services/predictionEngine";

const router = Router();

// --- Types ---

type BetMarketType =
  | "moneyline" | "puck_line" | "total_goals" | "regulation_result"
  | "period1_winner" | "period2_winner" | "period3_winner"
  | "game_to_ot" | "both_teams_score" | "winning_margin"
  | "first_team_score" | "team_total_goals" | "highest_scoring_period"
  | "anytime_goal" | "first_goal_scorer" | "shots_ou" | "assists_ou"
  | "points_ou" | "pp_point" | "goalie_saves_ou" | "penalty_minutes_ou"
  | "blocked_shots_ou" | "time_on_ice_ou" | "faceoff_wins_ou" | "hits_ou";

interface PredictionRequest {
  marketType: BetMarketType;
  gameId?: string;
  teamId?: string;
  opponentId?: string;
  playerId?: string;
  playerName?: string;
  selection?: string;
  line?: number;
  isHome?: boolean;
  seasonContext?: Record<string, unknown>;
}

// --- Helpers ---

function probToOddsLabel(pct: number): string {
  const p = Math.max(5, Math.min(95, pct)) / 100;
  if (p >= 0.5) return `-${Math.round((p / (1 - p)) * 100)}`;
  return `+${Math.round(((1 - p) / p) * 100)}`;
}

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

// --- Core prediction dispatcher ---

async function computeProbability(body: PredictionRequest): Promise<number> {
  const {
    marketType,
    teamId,
    opponentId,
    playerId,
    selection = "over",
    line = 0.5,
    isHome = true,
  } = body;

  // Team / game markets
  if (marketType === "moneyline" || marketType === "first_team_score") {
    if (!teamId) return 50;
    return predictMoneyline(teamId, opponentId, isHome);
  }

  if (marketType === "puck_line") {
    if (!teamId) return 28;
    return predictPuckLine(teamId, opponentId, isHome);
  }

  if (marketType === "regulation_result") {
    if (!teamId) return 40;
    const ml = await predictMoneyline(teamId, opponentId, isHome);
    return Math.max(5, Math.round(ml * 0.87));
  }

  if (marketType === "total_goals" || marketType === "team_total_goals") {
    return predictTotalGoals(line, selection, teamId, opponentId);
  }

  if (
    marketType === "period1_winner" ||
    marketType === "period2_winner" ||
    marketType === "period3_winner"
  ) {
    if (!teamId) return 38;
    const ml = await predictMoneyline(teamId, opponentId, isHome);
    return Math.max(20, Math.round(50 + (ml - 50) * 0.55));
  }

  if (marketType === "game_to_ot")          return 24;
  if (marketType === "both_teams_score")    return 85;
  if (marketType === "winning_margin")      return 12;
  if (marketType === "highest_scoring_period") return 38;

  // Player markets
  if (!playerId) return 50;

  if (marketType === "anytime_goal")     return predictAnytimeGoal(playerId);
  if (marketType === "first_goal_scorer") return predictFirstGoalScorer(playerId);
  if (marketType === "shots_ou")         return predictShotsOU(playerId, line, selection);
  if (marketType === "assists_ou")       return predictAssistsOU(playerId, line, selection);
  if (marketType === "points_ou")        return predictPointsOU(playerId, line, selection);
  if (marketType === "pp_point")         return predictPPPoint(playerId);

  if (
    marketType === "hits_ou" ||
    marketType === "blocked_shots_ou" ||
    marketType === "time_on_ice_ou" ||
    marketType === "faceoff_wins_ou" ||
    marketType === "penalty_minutes_ou" ||
    marketType === "goalie_saves_ou"
  ) {
    return predictPositionBasedProp(playerId, marketType, line, selection);
  }

  return 50;
}

// --- Routes ---

// POST /api/predict/single
router.post("/single", async (req: Request, res: Response) => {
  try {
    const body        = req.body as PredictionRequest;
    const probability = await computeProbability(body);

    const confidence =
      probability >= 70 ? "very_high" :
      probability >= 60 ? "high"      :
      probability >= 50 ? "medium"    :
      probability >= 40 ? "low"       : "very_low";

    const factorType = body.playerId ? "player" : "team";
    const factorId   = body.playerId ?? body.teamId ?? "";
    const factors    = factorId
      ? await buildRealFactors(factorType, factorId, probability)
      : [];

    res.json({
      probability,
      confidence,
      factors,
      oddsLabel: probToOddsLabel(probability),
      modelVersion: "nhl-stats-v1.0",
      generatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[predict/single]", err.message);
    res.status(500).json({ error: err.message ?? "Prediction failed" });
  }
});

// POST /api/predict/parlay
router.post("/parlay", (req: Request, res: Response) => {
  const { legs } = req.body as {
    legs: Array<{ marketType: BetMarketType; probability: number }>;
  };

  if (!Array.isArray(legs) || legs.length === 0) {
    res.status(400).json({ error: "legs array required" });
    return;
  }

  const combined = legs.reduce((acc, leg) => acc * (leg.probability / 100), 1) * 100;
  const adjusted = combined * 0.95;

  res.json({
    combinedProbability: Math.round(combined * 10) / 10,
    adjustedProbability: Math.round(adjusted * 10) / 10,
    legs: legs.map((leg) => ({
      marketType:  leg.marketType,
      probability: leg.probability,
    })),
  });
});

// GET /api/predict/markets/game/:id
router.get("/markets/game/:id", (_req: Request, res: Response) => {
  res.json(GAME_MARKET_TYPES);
});

// GET /api/predict/markets/player/:id
router.get("/markets/player/:id", (_req: Request, res: Response) => {
  res.json(PLAYER_MARKET_TYPES);
});

// POST /api/predict/factors
router.post("/factors", async (req: Request, res: Response) => {
  try {
    const { type, id, context = {} } = req.body as {
      type: string;
      id: string;
      context?: Record<string, unknown>;
    };

    const fallbackPct = (context.fallbackPct as number) ?? 50;
    const factors     = await buildRealFactors(type, id, fallbackPct);
    const deltaSum    = factors.reduce((s, f) => s + (f.delta ?? 0), 0);
    const finalPct    = Math.round(Math.max(3, Math.min(97, 50 + deltaSum)));

    res.json({ basePct: 50, factors, finalPct });
  } catch (err: any) {
    console.error("[predict/factors]", err.message);
    res.status(500).json({ error: err.message ?? "Factors failed" });
  }
});

// POST /api/predict/player-prop  (season-long prop)
router.post("/player-prop", async (req: Request, res: Response) => {
  try {
    const { playerName, propType, line, playerId } = req.body as {
      playerName: string;
      propType: "goals" | "points" | "assists" | "award";
      line: number;
      playerId?: string;
    };

    let probability = 50;
    let factors: any[] = [];
    let betNote = `${playerName} season prop estimate.`;

    if (playerId) {
      const { fetchPlayerById } = await import("../services/nhlApiClient");
      const player = await fetchPlayerById(playerId);

      const gp = player.gamesPlayed || 1;
      const remaining = Math.max(0, 82 - gp);
      const current =
        propType === "goals"   ? player.goals   :
        propType === "points"  ? player.points  :
        propType === "assists" ? player.assists  : 0;

      const pace        = (current / gp) * 82;
      const needed      = line - current;
      const currentRate = current / gp;
      const rateNeeded  = remaining > 0 ? needed / remaining : Infinity;

      probability =
        needed <= 0                      ? 95 :
        rateNeeded <= currentRate * 0.85 ? 75 :
        rateNeeded <= currentRate        ? 62 :
        rateNeeded <= currentRate * 1.15 ? 45 : 28;

      probability = Math.max(3, Math.min(97, probability));

      factors = [
        { icon: "chart", label: `Season pace: ${pace.toFixed(0)} (line: ${line})`, delta: pace >= line ? 12 : -8 },
        { icon: "calendar", label: `${remaining} games remaining, needs ${needed} more`, delta: remaining >= 20 ? 5 : remaining >= 10 ? 2 : -3 },
        { icon: "trending", label: `Averaging ${currentRate.toFixed(2)}/game`, delta: currentRate >= rateNeeded ? 6 : -4 },
      ];
      betNote = `${player.name || playerName} needs ${needed} more ${propType} in ${remaining} games (pace: ${pace.toFixed(0)}).`;
    }

    res.json({
      probability,
      oddsLabel: probToOddsLabel(probability),
      factors,
      betNote,
    });
  } catch (err: any) {
    console.error("[predict/player-prop]", err.message);
    res.status(500).json({ error: err.message ?? "Player prop failed" });
  }
});

// POST /api/predict/futures
router.post("/futures", async (req: Request, res: Response) => {
  try {
    const { teamName, teamId, propType } = req.body as {
      teamName: string;
      teamId?: string;
      propType: "cup" | "conf" | "playoff";
    };

    const id          = teamId ?? teamName;
    const probability = await predictFutures(id, propType);

    res.json({
      probability,
      oddsLabel: probToOddsLabel(probability),
      factors: [
        { icon: "standings", label: `${teamName} standings rank`, delta: probability >= 20 ? 8 : -4 },
      ],
      betNote: `${teamName} ${propType} probability based on current standings.`,
    });
  } catch (err: any) {
    console.error("[predict/futures]", err.message);
    res.status(500).json({ error: err.message ?? "Futures failed" });
  }
});

export default router;
