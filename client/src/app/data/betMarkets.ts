import type { BetMarketType } from "../types/bet";

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
  // ── Nouveaux marchés NHL bet365 ────────────────────────────────────────────
  {
    type: "double_chance",
    label: "Double Chance",
    shortLabel: "Double Chance",
    category: "match",
    description: "Home/Draw or Away/Draw — insures against one outcome",
    requiresLine: false,
    requiresSelection: true,
    selectionOptions: [
      { label: "Home or Draw", value: "home_draw" },
      { label: "Away or Draw", value: "away_draw" },
      { label: "Home or Away", value: "home_away" },
    ],
  },
  {
    type: "alt_puck_line",
    label: "Alternate Puck Line",
    shortLabel: "Alt Puck Line",
    category: "match",
    description: "Alternative puck line spreads (-2.5, +2.5, etc.)",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [-2.5, -1.5, 1.5, 2.5],
    lineUnit: "goals",
    selectionOptions: [
      { label: "Home", value: "home" },
      { label: "Away", value: "away" },
    ],
  },
  {
    type: "ot_winner",
    label: "Overtime Winner",
    shortLabel: "OT Winner",
    category: "special",
    description: "Who wins if the game goes to overtime/shootout",
    requiresLine: false,
    requiresSelection: true,
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
  {
    type: "period1_total_goals",
    label: "1st Period Total Goals (O/U)",
    shortLabel: "P1 Total",
    category: "period",
    description: "Goals scored in the 1st period over or under the line",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [0.5, 1.5, 2.5],
    lineUnit: "goals",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },
  {
    type: "period2_total_goals",
    label: "2nd Period Total Goals (O/U)",
    shortLabel: "P2 Total",
    category: "period",
    description: "Goals scored in the 2nd period over or under the line",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [0.5, 1.5, 2.5],
    lineUnit: "goals",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },
  {
    type: "period3_total_goals",
    label: "3rd Period Total Goals (O/U)",
    shortLabel: "P3 Total",
    category: "period",
    description: "Goals scored in the 3rd period over or under the line",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [0.5, 1.5, 2.5],
    lineUnit: "goals",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
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
    type: "last_team_score",
    label: "Last Team to Score",
    shortLabel: "Last Goal",
    category: "team",
    description: "Which team scores the game's final goal",
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
  {
    type: "clean_sheet",
    label: "Clean Sheet",
    shortLabel: "Clean Sheet",
    category: "team",
    description: "Team does not concede a single goal",
    requiresLine: false,
    requiresSelection: true,
  },
  {
    type: "team_score_every_period",
    label: "Team Scores in Every Period",
    shortLabel: "Every Period",
    category: "team",
    description: "Team scores at least one goal in each of the three periods",
    requiresLine: false,
    requiresSelection: true,
  },
  {
    type: "total_penalties",
    label: "Total Penalty Minutes (O/U)",
    shortLabel: "Total PIM",
    category: "special",
    description: "Combined penalty minutes in the game over or under the line",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [8.5, 10.5, 12.5, 14.5, 16.5],
    lineUnit: "PIM",
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
    type: "last_goal_scorer",
    label: "Last Goal Scorer",
    shortLabel: "Last G",
    category: "player",
    description: "Player scores the last goal of the game",
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

// ── Tennis Market Definitions ─────────────────────────────────────────────────

export interface TennisMarketDefinition {
  type: BetMarketType;
  label: string;
  shortLabel: string;
  category: "match" | "set" | "game" | "player" | "special";
  description: string;
  requiresLine: boolean;
  requiresSelection: boolean;
  selectionOptions?: { label: string; value: string }[];
  lineOptions?: number[];
  lineUnit?: string;
}

export const TENNIS_MARKET_DEFINITIONS: TennisMarketDefinition[] = [
  // ── Match ─────────────────────────────────────────────────────────────────
  {
    type: "tennis_match_winner",
    label: "Match Winner",
    shortLabel: "Winner",
    category: "match",
    description: "Pick the player who wins the match",
    requiresLine: false,
    requiresSelection: true,
  },
  {
    type: "tennis_total_sets",
    label: "Total Sets (O/U)",
    shortLabel: "Total Sets",
    category: "match",
    description: "Total number of sets played over or under the line",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [2.5, 3.5],
    lineUnit: "sets",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },
  {
    type: "tennis_correct_score",
    label: "Correct Score (Sets)",
    shortLabel: "Correct Score",
    category: "match",
    description: "Exact set score for the match (e.g. 2-0, 2-1)",
    requiresLine: false,
    requiresSelection: true,
    selectionOptions: [
      { label: "2-0 (P1)", value: "2-0" },
      { label: "2-1 (P1)", value: "2-1" },
      { label: "0-2 (P2)", value: "0-2" },
      { label: "1-2 (P2)", value: "1-2" },
    ],
  },
  {
    type: "tennis_to_win_set",
    label: "To Win a Set",
    shortLabel: "Win a Set",
    category: "match",
    description: "Player wins at least one set during the match",
    requiresLine: false,
    requiresSelection: true,
  },
  {
    type: "tennis_tiebreak",
    label: "Tiebreak in Match",
    shortLabel: "Tiebreak",
    category: "special",
    description: "Will any tiebreak be played during the match?",
    requiresLine: false,
    requiresSelection: false,
  },
  // ── Set markets ───────────────────────────────────────────────────────────
  {
    type: "tennis_first_set",
    label: "First Set Winner",
    shortLabel: "1st Set",
    category: "set",
    description: "Who wins the opening set",
    requiresLine: false,
    requiresSelection: true,
  },
  {
    type: "tennis_set_handicap",
    label: "Set Handicap",
    shortLabel: "Set HCP",
    category: "set",
    description: "Set handicap applied to match (e.g. Player A -1.5 sets)",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [-1.5, 1.5],
    lineUnit: "sets",
    selectionOptions: [
      { label: "Player 1", value: "p1" },
      { label: "Player 2", value: "p2" },
    ],
  },
  {
    type: "tennis_first_set_games",
    label: "1st Set Total Games (O/U)",
    shortLabel: "1st Set Games",
    category: "set",
    description: "Total games played in the first set over or under",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [8.5, 9.5, 10.5, 11.5],
    lineUnit: "games",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },
  // ── Game markets ──────────────────────────────────────────────────────────
  {
    type: "tennis_total_games",
    label: "Total Games (O/U)",
    shortLabel: "Total Games",
    category: "game",
    description: "Total games played in the entire match over or under",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [18.5, 20.5, 22.5, 24.5, 26.5],
    lineUnit: "games",
    selectionOptions: [
      { label: "Over", value: "over" },
      { label: "Under", value: "under" },
    ],
  },
  {
    type: "tennis_game_handicap",
    label: "Game Handicap",
    shortLabel: "Game HCP",
    category: "game",
    description: "Game handicap applied across the full match",
    requiresLine: true,
    requiresSelection: true,
    lineOptions: [-5.5, -3.5, -1.5, 1.5, 3.5, 5.5],
    lineUnit: "games",
    selectionOptions: [
      { label: "Player 1", value: "p1" },
      { label: "Player 2", value: "p2" },
    ],
  },
];

export const TENNIS_CATEGORY_LABELS: Record<TennisMarketDefinition["category"], string> = {
  match: "Match Result",
  set: "Set Betting",
  game: "Game Betting",
  player: "Player Props",
  special: "Specials",
};

export const TENNIS_CATEGORY_ICONS: Record<TennisMarketDefinition["category"], string> = {
  match: "🎾",
  set: "📋",
  game: "🏓",
  player: "⭐",
  special: "✨",
};

export function getTennisMarketsByCategory(category: TennisMarketDefinition["category"]) {
  return TENNIS_MARKET_DEFINITIONS.filter((m) => m.category === category);
}

export const CATEGORY_LABELS: Record<MarketDefinition["category"], string> = {
  game:    "Game Lines",
  team:    "Team Props",
  player:  "Player Props",
  period:  "Period Betting",
  special: "Specials",
};

export const CATEGORY_ICONS: Record<MarketDefinition["category"], string> = {
  game:    "🏒",
  team:    "🛡",
  player:  "⛸",
  period:  "⏱",
  special: "⚡",
};
