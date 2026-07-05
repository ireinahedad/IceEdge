/**
 * Shared prediction-request builder.
 *
 * BOTH the stats page (which describes bets with "ML props") and the coupon /
 * market selector (which describes bets with a market type + selection) funnel
 * their requests through here, so the exact same bet always produces the exact
 * same PredictionRequest — and therefore the exact same probability from the
 * server. This is what keeps the coupon and the stats page consistent.
 */
import type { BetMarketType, PredictionRequest } from "../types/bet";

/** ML-vocabulary aliases used by the stats page → canonical market + selection. */
export function normalizeMarket(
  propType: string,
  selection?: string
): { marketType: BetMarketType; selection?: string } {
  switch (propType) {
    case "total_goals_over":  return { marketType: "total_goals", selection: "over" };
    case "total_goals_under": return { marketType: "total_goals", selection: "under" };
    case "pp_goal":           return { marketType: "team_pp_goals", selection };
    case "penalty_kill":      return { marketType: "team_penalty_kill", selection };
    default:                  return { marketType: propType as BetMarketType, selection };
  }
}

interface MLPropsLike {
  type: "game" | "player" | "team";
  subjectId: string;
  opponentId?: string;
  propType?: string;
  line?: number;
  isHome?: boolean;
  selection?: string;
}

/**
 * Build a canonical PredictionRequest from a stats-page bet option.
 * Team/game subjects → teamId (+ opponentId/isHome); player subjects → playerId.
 */
export function requestFromMLProps(mlProps: MLPropsLike): PredictionRequest {
  const { marketType, selection } = normalizeMarket(
    mlProps.propType ?? "moneyline",
    mlProps.selection
  );

  const base: PredictionRequest = { marketType, line: mlProps.line };

  if (mlProps.type === "player") {
    base.playerId = mlProps.subjectId;
  } else {
    base.teamId     = mlProps.subjectId;
    base.opponentId = mlProps.opponentId;
    base.isHome     = mlProps.isHome ?? true;
  }
  if (selection != null) base.selection = selection;

  return base;
}
