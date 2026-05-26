import type { BetMarketType } from "../services/types";

export interface MarketDefinition {
  type: BetMarketType;
  label: string;
  shortLabel: string;
  category: "match" | "team" | "player" | "period" | "special";
  description: string;
  requiresLine: boolean;
  requiresSelection: boolean;
  selectionOptions?: { label: string; value: string }[];
  lineOptions?: number[];
  lineUnit?: string;
}

export const MARKET_DEFINITIONS: MarketDefinition[] = [
  // ── Match ─────────────────────────────────────────────────────────────────
  {
    type: "moneyline",
    label: "Match Result (Moneyline)",
    shortLabel: "Moneyline",
    category: "match",
    description: "Pick the team that wins (incl. OT/SO)",
    requiresLine: false,
    requiresSelection: true,
  },
  {
    type: "puck_line",
    label: "Puck Line (–1.5 Goals)",
    shortLabel: "Puck Line",
    category: "match",
    description: "Favored team wins by 2 or more goals",
    requiresLine: false,
    requiresSelection: true,
  },
  {
    type: "total_goals",
    label: "Total Goals (O/U)",
    shortLabel: "Total Goals",
    category: "match",
    description: "Combined goals in the game over or under the line",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [4.5, 5.0, 5.5, 6.0, 6.5, 7.0],
    lineUnit: "goals",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },
  {
    type: "regulation_result",
    label: "60-Minute Result",
    shortLabel: "Regulation",
    category: "match",
    description: "Winner after 60 minutes of regulation (no OT/SO)",
    requiresLine: false,
    requiresSelection: true,
  },
  {
    type: "game_to_ot",
    label: "Game to Go to OT/SO",
    shortLabel: "OT/SO",
    category: "special",
    description: "Game will not be decided in regulation",
    requiresLine: false,
    requiresSelection: false,
  },
  {
    type: "both_teams_score",
    label: "Both Teams to Score",
    shortLabel: "BTTS",
    category: "match",
    description: "Both teams score at least one goal",
    requiresLine: false,
    requiresSelection: false,
  },
  {
    type: "winning_margin",
    label: "Winning Margin",
    shortLabel: "Margin",
    category: "match",
    description: "Exact goal margin by which the winner wins",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [1, 2, 3],
    lineUnit: "goals",
    selectionOptions: [
      { label: "Home wins by exactly 1", value: "home_1" },
      { label: "Home wins by 2+", value: "home_2plus" },
      { label: "Away wins by exactly 1", value: "away_1" },
      { label: "Away wins by 2+", value: "away_2plus" },
    ],
  },

  // ── Period ────────────────────────────────────────────────────────────────
  {
    type: "period1_winner",
    label: "1st Period Winner",
    shortLabel: "P1 Winner",
    category: "period",
    description: "Team leading at end of 1st period",
    requiresLine: false,
    requiresSelection: true,
  },
  {
    type: "period2_winner",
    label: "2nd Period Winner",
    shortLabel: "P2 Winner",
    category: "period",
    description: "Team leading at end of 2nd period",
    requiresLine: false,
    requiresSelection: true,
  },
  {
    type: "period3_winner",
    label: "3rd Period Winner",
    shortLabel: "P3 Winner",
    category: "period",
    description: "Team leading at end of 3rd period",
    requiresLine: false,
    requiresSelection: true,
  },
  {
    type: "highest_scoring_period",
    label: "Highest Scoring Period",
    shortLabel: "High Period",
    category: "period",
    description: "Which period will have the most goals",
    requiresLine: false,
    requiresSelection: true,
    selectionOptions: [
      { label: "1st Period", value: "P1" },
      { label: "2nd Period", value: "P2" },
      { label: "3rd Period", value: "P3" },
    ],
  },

  // ── Team Props ────────────────────────────────────────────────────────────
  {
    type: "first_team_score",
    label: "First Team to Score",
    shortLabel: "First Goal",
    category: "team",
    description: "Which team scores the game's first goal",
    requiresLine: false,
    requiresSelection: true,
  },
  {
    type: "team_total_goals",
    label: "Team Total Goals (O/U)",
    shortLabel: "Team Total",
    category: "team",
    description: "One team's goals over or under the line",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [1.5, 2.0, 2.5, 3.0, 3.5],
    lineUnit: "goals",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },
  {
    type: "team_pp_goals",
    label: "Team Power Play Goals (O/U)",
    shortLabel: "PP Goals",
    category: "team",
    description: "Power play goals in the game over or under",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [0.5, 1.5, 2.5],
    lineUnit: "PP goals",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },

  // ── Player Props ──────────────────────────────────────────────────────────
  {
    type: "anytime_goal",
    label: "Anytime Goal Scorer",
    shortLabel: "Anytime G",
    category: "player",
    description: "Player scores at least one goal",
    requiresLine: false,
    requiresSelection: false,
  },
  {
    type: "first_goal_scorer",
    label: "First Goal Scorer",
    shortLabel: "First G",
    category: "player",
    description: "Player scores the first goal of the game",
    requiresLine: false,
    requiresSelection: false,
  },
  {
    type: "shots_ou",
    label: "Shots on Goal (O/U)",
    shortLabel: "Shots O/U",
    category: "player",
    description: "Player shots on goal over or under the line",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [1.5, 2.5, 3.5, 4.5, 5.5],
    lineUnit: "shots",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },
  {
    type: "assists_ou",
    label: "Assists (O/U)",
    shortLabel: "Assists O/U",
    category: "player",
    description: "Player total assists over or under the line",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [0.5, 1.5, 2.5],
    lineUnit: "assists",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },
  {
    type: "points_ou",
    label: "Points (Goals + Assists) O/U",
    shortLabel: "Points O/U",
    category: "player",
    description: "Player total points (G+A) over or under the line",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [0.5, 1.5, 2.5, 3.5],
    lineUnit: "points",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },
  {
    type: "pp_point",
    label: "Power Play Point",
    shortLabel: "PP Point",
    category: "player",
    description: "Player records a point on the power play",
    requiresLine: false,
    requiresSelection: false,
  },
  {
    type: "goalie_saves_ou",
    label: "Goalie Saves (O/U)",
    shortLabel: "Saves O/U",
    category: "player",
    description: "Goalie total saves over or under the line",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [20.5, 22.5, 24.5, 26.5, 28.5, 30.5],
    lineUnit: "saves",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },
  {
    type: "blocked_shots_ou",
    label: "Blocked Shots (O/U)",
    shortLabel: "Blocks O/U",
    category: "player",
    description: "Player blocked shots over or under the line",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [0.5, 1.5, 2.5, 3.5],
    lineUnit: "blocks",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },
  {
    type: "hits_ou",
    label: "Hits (O/U)",
    shortLabel: "Hits O/U",
    category: "player",
    description: "Player hits over or under the line",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [0.5, 1.5, 2.5, 3.5, 4.5],
    lineUnit: "hits",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },
  {
    type: "time_on_ice_ou",
    label: "Time on Ice (O/U)",
    shortLabel: "TOI O/U",
    category: "player",
    description: "Player minutes on ice over or under the line",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [14.5, 16.5, 18.5, 20.5, 22.5],
    lineUnit: "min",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },
  {
    type: "faceoff_wins_ou",
    label: "Faceoff Wins (O/U)",
    shortLabel: "FO Wins O/U",
    category: "player",
    description: "Center faceoff wins over or under the line",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [5.5, 7.5, 9.5, 11.5, 13.5],
    lineUnit: "FO wins",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },
  {
    type: "penalty_minutes_ou",
    label: "Penalty Minutes (O/U)",
    shortLabel: "PIM O/U",
    category: "player",
    description: "Player penalty minutes over or under the line",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [0.5, 1.5, 2.5],
    lineUnit: "PIM",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },
];

export const CATEGORY_LABELS: Record<MarketDefinition["category"], string> = {
  match: "Match Result",
  team: "Team Props",
  player: "Player Props",
  period: "Period Betting",
  special: "Specials",
};

export const CATEGORY_ICONS: Record<MarketDefinition["category"], string> = {
  match: "🏒",
  team: "🛡️",
  player: "⭐",
  period: "⏱️",
  special: "✨",
};

export function getMarketsByCategory(category: MarketDefinition["category"]) {
  return MARKET_DEFINITIONS.filter((m) => m.category === category);
}

export function getMarketByType(type: BetMarketType) {
  return MARKET_DEFINITIONS.find((m) => m.type === type);
}
