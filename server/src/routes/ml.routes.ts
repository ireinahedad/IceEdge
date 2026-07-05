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
  predictDoubleChance,
  predictAltPuckLine,
  predictRegulationResult,
  predictTeamToScore,
  predictBothTeamsScore,
  predictCleanSheet,
  predictTeamPPGoal,
  predictPenaltyKill,
  predictWinningMargin,
  predictPeriodWinner,
  predictPeriodTotalGoals,
  buildRealFactors,
} from "../services/predictionEngine";
import { mlApiClient } from "../services/mlApiClient";
import { fetchGameById } from "../services/nhlApiClient";
import {
  buildGameFeatures,
  buildPlayerPropFeatures,
  buildTeamFuturesFeatures,
} from "../services/featureEngineering";
import { getBestBets } from "../services/bestBets.service";

const router = Router();

// GET /api/predict/best-bets
// Top individual bets across all markets (team + player props),
// ranked by prediction score. ML-first with rule fallback.
// Query: ?limit=15&source=ml|rules&days=3&players=15
router.get("/best-bets", async (req: Request, res: Response) => {
  try {
    const source = req.query.source === "rules" ? "rules" : "ml";
    const result = await getBestBets({
      limit:      req.query.limit   ? parseInt(String(req.query.limit), 10)   : undefined,
      days:       req.query.days    ? parseInt(String(req.query.days), 10)    : undefined,
      maxPlayers: req.query.players ? parseInt(String(req.query.players), 10) : undefined,
      source,
    });
    res.json(result);
  } catch (err: any) {
    console.error("[predict/best-bets]", err.message);
    res.status(500).json({ error: err.message ?? "Best bets failed" });
  }
});

// --- Types ---

type BetMarketType =
  | "moneyline" | "puck_line" | "total_goals" | "regulation_result"
  | "period1_winner" | "period2_winner" | "period3_winner"
  | "period1_total_goals" | "period2_total_goals" | "period3_total_goals"
  | "game_to_ot" | "both_teams_score" | "winning_margin"
  | "double_chance" | "alt_puck_line" | "ot_winner"
  | "first_team_score" | "last_team_score" | "team_total_goals"
  | "team_pp_goals" | "team_penalty_kill" | "clean_sheet"
  | "highest_scoring_period"
  // ML-vocab aliases sent by the stats page (mapped to canonical markets)
  | "total_goals_over" | "total_goals_under" | "pp_goal" | "penalty_kill"
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

/**
 * Normalise ML-vocabulary aliases (sent by the stats page) into the canonical
 * { marketType, selection } used by the prediction engine. This is what keeps
 * the coupon and the stats page in sync: both funnel into the same markets.
 */
function normalizeMarket(
  marketType: string,
  selection: string
): { market: string; selection: string } {
  switch (marketType) {
    case "total_goals_over":  return { market: "total_goals", selection: "over" };
    case "total_goals_under": return { market: "total_goals", selection: "under" };
    case "pp_goal":           return { market: "team_pp_goals", selection };
    case "penalty_kill":      return { market: "team_penalty_kill", selection };
    default:                  return { market: marketType, selection };
  }
}

/**
 * Resolve a game-based request into concrete team/opponent/home-ice values.
 * The coupon sends { gameId, selection: <teamAbbr> } with no teamId; the stats
 * page sends { teamId, opponentId, isHome } directly. Both must end up equal.
 */
async function resolveSubjects(body: PredictionRequest): Promise<{
  teamId?: string;
  opponentId?: string;
  isHome: boolean;
  selection: string;
}> {
  let teamId     = body.teamId;
  let opponentId = body.opponentId;
  let isHome     = body.isHome ?? true;
  let selection  = body.selection ?? "over";

  if (body.gameId) {
    try {
      const game = await fetchGameById(body.gameId);
      const home = game?.homeTeam?.id ?? game?.homeTeam?.abbreviation;
      const away = game?.awayTeam?.id ?? game?.awayTeam?.abbreviation;
      const sel  = selection?.toLowerCase();
      // selection is a team abbreviation → that team is the subject
      if (sel && (sel === String(home).toLowerCase() || sel === String(away).toLowerCase())) {
        const selIsHome = sel === String(home).toLowerCase();
        teamId     = selIsHome ? home : away;
        opponentId = selIsHome ? away : home;
        isHome     = selIsHome;
      } else if (!teamId) {
        // over/under & game-level markets: default to the home side as anchor
        teamId     = home;
        opponentId = away;
        isHome     = true;
      }
    } catch {
      /* fall back to whatever the body provided */
    }
  }

  return { teamId, opponentId, isHome, selection };
}

async function computeProbability(body: PredictionRequest): Promise<number> {
  const { market } = normalizeMarket(body.marketType, body.selection ?? "over");
  const line = body.line ?? 0.5;
  const { teamId, opponentId, isHome, selection } = await resolveSubjects({
    ...body,
    selection: normalizeMarket(body.marketType, body.selection ?? "over").selection,
  });
  const playerId = body.playerId;

  // ── Game / team markets ──────────────────────────────────────────────────
  if (market === "moneyline") {
    if (!teamId) return 50;
    return predictMoneyline(teamId, opponentId, isHome);
  }
  if (market === "first_team_score" || market === "last_team_score") {
    if (!teamId) return 50;
    return predictTeamToScore(teamId, opponentId, isHome);
  }
  if (market === "puck_line") {
    if (!teamId) return 28;
    return predictPuckLine(teamId, opponentId, isHome);
  }
  if (market === "alt_puck_line") {
    if (!teamId) return 50;
    return predictAltPuckLine(teamId, opponentId, isHome);
  }
  if (market === "double_chance" || market === "ot_winner") {
    if (!teamId) return 50;
    return predictDoubleChance(teamId, opponentId, isHome);
  }
  if (market === "regulation_result") {
    if (!teamId) return 40;
    return predictRegulationResult(teamId, opponentId, isHome);
  }
  if (market === "total_goals" || market === "team_total_goals") {
    return predictTotalGoals(line, selection, teamId, opponentId);
  }
  if (
    market === "period1_total_goals" ||
    market === "period2_total_goals" ||
    market === "period3_total_goals"
  ) {
    return predictPeriodTotalGoals(line, selection, teamId, opponentId);
  }
  if (
    market === "period1_winner" ||
    market === "period2_winner" ||
    market === "period3_winner"
  ) {
    if (!teamId) return 38;
    return predictPeriodWinner(teamId, opponentId, isHome);
  }
  if (market === "both_teams_score")   return predictBothTeamsScore(teamId, opponentId);
  if (market === "clean_sheet")        return predictCleanSheet(teamId, opponentId);
  if (market === "team_pp_goals")      return predictTeamPPGoal(teamId);
  if (market === "team_penalty_kill")  return predictPenaltyKill(teamId);
  if (market === "winning_margin")     return predictWinningMargin();
  if (market === "game_to_ot")         return 24;
  if (market === "highest_scoring_period") return 38;

  // ── Player markets ─────────────────────────────────────────────────────────
  if (!playerId) return 50;

  if (market === "anytime_goal")     return predictAnytimeGoal(playerId);
  if (market === "first_goal_scorer") return predictFirstGoalScorer(playerId);
  if (market === "last_goal_scorer")  return predictFirstGoalScorer(playerId);
  if (market === "shots_ou")         return predictShotsOU(playerId, line, selection);
  if (market === "assists_ou")       return predictAssistsOU(playerId, line, selection);
  if (market === "points_ou")        return predictPointsOU(playerId, line, selection);
  if (market === "pp_point")         return predictPPPoint(playerId);

  if (
    market === "hits_ou" ||
    market === "blocked_shots_ou" ||
    market === "time_on_ice_ou" ||
    market === "faceoff_wins_ou" ||
    market === "penalty_minutes_ou" ||
    market === "goalie_saves_ou"
  ) {
    return predictPositionBasedProp(playerId, market, line, selection);
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

// ── ML service proxy ──────────────────────────────────────────────────────────
//
// POST /api/predict/ml
// Builds feature vector from NHL API data, POSTs it to the Python ML service,
// and returns the ML response. Falls back to null (frontend handles gracefully).
//
// Body: { type, subjectId, opponentId?, propType?, line?, selection? }

router.post('/ml', async (req: Request, res: Response) => {
  try {
    const { type, subjectId, opponentId, propType, line, selection, meta } = req.body as {
      type:        'game' | 'player' | 'team' | 'tennis';
      subjectId:   string;
      opponentId?: string;
      propType?:   string;
      line?:       number;
      selection?:  string;
      meta?:       Record<string, unknown>;
    };

    if (!type || !subjectId) {
      return res.status(400).json({ error: 'type and subjectId are required' });
    }

    let result;

    if (type === 'game') {
      const marketType = propType ?? 'moneyline';
      const features = await buildGameFeatures(subjectId, opponentId ?? subjectId, marketType, line);
      result = await mlApiClient.predictGame(features);
    } else if (type === 'player') {
      const features = await buildPlayerPropFeatures(
        subjectId,
        propType ?? 'goals',
        line    ?? 0.5,
        selection ?? 'over'
      );
      result = await mlApiClient.predictPlayer(features);
    } else if (type === 'team') {
      const features = await buildTeamFuturesFeatures(subjectId, propType ?? 'moneyline');
      result = await mlApiClient.predictTeam(features);
    } else if (type === 'tennis') {
      // Map tennis match context → player Poisson model
      const p1WinPct  = Number((meta?.p1WinPct  as number | undefined) ?? 50);
      const p2WinPct  = Number((meta?.p2WinPct  as number | undefined) ?? 50);
      const surface   = String( meta?.surface   ?? 'Hard');
      const marketType = propType ?? 'tennis_match_winner';

      const winRate = Math.max(0.1, Math.min(0.9, p1WinPct / 100));
      const balance = 1 - Math.abs(p1WinPct - p2WinPct) / 100; // 0=unbalanced, 1=even
      const isClay  = surface === 'Clay';
      const isGrass = surface === 'Grass';

      // Surface-driven corrections: ML diverges from simple win%-rules
      // Clay: top players dominate more (slower baseline game amplifies ranking gap)
      // Grass: variance increases, serve dominance compresses win% differences
      const surfaceMult   = isClay ? 1.14 : isGrass ? 0.86 : 1.0;
      // Model also picks up ranking-points differential beyond raw win%
      const pointsSignal  = (p1WinPct - p2WinPct) / 100 * 0.07;

      // Derive model inputs per market
      let goalsPerGame = winRate;
      let modelLine    = 0.5;
      let fpropType    = 'goals';

      if (marketType === 'tennis_match_winner' || marketType === 'tennis_first_set') {
        // Surface + ranking-depth correction — key ML divergence from rules
        goalsPerGame = winRate * surfaceMult + pointsSignal;
      } else if (marketType === 'tennis_total_sets') {
        // Clay → more sets (baseline rallies, fewer quick wins); grass → fewer sets
        const surfaceSetBias = isClay ? 0.14 : isGrass ? -0.18 : 0.0;
        goalsPerGame = 0.35 + balance * 0.45 + surfaceSetBias;
      } else if (marketType === 'tennis_tiebreak') {
        // Grass → serve dominance → more tiebreaks; clay → fewer
        const surfaceTieBias = isGrass ? 0.22 : isClay ? -0.14 : 0.0;
        goalsPerGame = 0.20 + balance * 0.55 + surfaceTieBias;
      } else if (marketType === 'tennis_total_games') {
        const avgGames = isClay ? 24.5 : isGrass ? 21.5 : 22.8;
        goalsPerGame = avgGames / 24.0;
        modelLine    = 0.9;
        fpropType    = 'points';
      } else if (marketType === 'tennis_first_set_games') {
        const avgFirst = isClay ? 10.8 : 9.6;
        goalsPerGame = avgFirst / 9.5;
        modelLine    = 0.9;
        fpropType    = 'shots';
      } else if (marketType === 'tennis_correct_score') {
        // ML uses surface: dominant favorites close 2-0 more on clay
        goalsPerGame = winRate * (isClay ? 0.60 : 0.50) + pointsSignal;
      } else if (marketType === 'tennis_to_win_set') {
        // Underdog chance amplified on grass (serve holds), reduced on clay
        const underdog = (1 - winRate) + balance * 0.25;
        goalsPerGame = isGrass ? Math.min(0.85, underdog * 1.18) : isClay ? underdog * 0.82 : underdog;
      } else if (marketType === 'tennis_set_handicap' || marketType === 'tennis_game_handicap') {
        goalsPerGame = winRate * surfaceMult * 0.85 + pointsSignal;
      } else {
        goalsPerGame = winRate * surfaceMult + pointsSignal;
      }

      const features = {
        goals_per_game:   Math.max(0.05, Math.min(0.95, goalsPerGame)),
        assists_per_game: winRate * 0.5,
        points_per_game:  winRate,
        shots_per_game:   3.0,
        games_played:     50,
        line:             modelLine,
        prop_type:        fpropType,
        selection:        'over',
      };
      result = await mlApiClient.predictPlayer(features as any);
    } else {
      return res.status(400).json({ error: `Unknown type: ${type}` });
    }

    res.json(result);
  } catch (err: any) {
    // ML service may be down — return 503 so frontend can silently hide the section
    console.warn('[predict/ml] ML service unavailable:', err.message);
    res.status(503).json({ error: 'ML service unavailable', detail: err.message });
  }
});

export default router;
