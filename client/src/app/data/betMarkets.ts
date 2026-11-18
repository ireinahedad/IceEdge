import { CalendarDays, Shield, User, Timer, Zap, type LucideIcon } from "lucide-react";
import type { BetMarketType } from "../types/bet";
// Lignes des six marchés plus/moins : source unique partagée avec le serveur
// (validation du Bet builder IA). Voir l'en-tête de marketLines.ts.
import { MARKET_LINES } from "../../../../server/src/services/marketLines";

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
    lineOptions: [...MARKET_LINES.total_goals],
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
    // Sur 60 minutes, comme les livres. Sélection = une équipe (« elle gagne
    // en 60 OU nul après 60 ») ou `no_draw` (« l'une des deux gagne en 60 »).
    type: "double_chance",
    label: "Double Chance (60 min)",
    shortLabel: "Dbl Chance",
    category: "match",
    description: "Two of the three regulation outcomes: a team or a draw, or no draw",
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
    lineOptions: [...MARKET_LINES.team_total_goals],
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
    lineOptions: [...MARKET_LINES.shots_ou],
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
    lineOptions: [...MARKET_LINES.assists_ou],
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
    lineOptions: [...MARKET_LINES.points_ou],
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
    lineOptions: [...MARKET_LINES.goalie_saves_ou],
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

// ⚠️ La clé est « match », pas « game » : aucune des 37 définitions n'utilise
// `category: "game"`. Les deux tables ci-dessous étaient donc interrogées avec
// « match » et rendaient `undefined` — le groupe de marchés le plus important de
// la feuille s'affichait sans titre ni icône.
export const CATEGORY_LABELS: Record<MarketDefinition["category"], string> = {
  match:   "Game Lines",
  team:    "Team Props",
  player:  "Player Props",
  period:  "Period Betting",
  special: "Specials",
};

export const CATEGORY_ICONS: Record<MarketDefinition["category"], LucideIcon> = {
  match:   CalendarDays,
  team:    Shield,
  player:  User,
  period:  Timer,
  special: Zap,
};

/* ─── Version française (2026-11-18) ─────────────────────────────────────────
 * Les définitions ci-dessus sont la source (anglais) ; la feuille de marchés et
 * `buildLeg` passent par `localizeMarket` pour l'affichage. Le `type` ne change
 * jamais : c'est lui que lisent le règlement et le modèle.
 */
const MARKET_FR: Partial<Record<BetMarketType, { label: string; short: string; desc: string; unit?: string }>> = {
  moneyline:               { label: "Vainqueur du match", short: "Vainqueur", desc: "L'équipe qui gagne (prolongation et tirs de barrage compris)" },
  puck_line:               { label: "Écart (puck line, −1,5 but)", short: "Écart", desc: "L'équipe favorite gagne par 2 buts ou plus" },
  total_goals:             { label: "Total de buts (plus/moins)", short: "Total de buts", desc: "Buts des deux équipes au-dessus ou au-dessous de la ligne", unit: "buts" },
  regulation_result:       { label: "Résultat à 60 minutes", short: "60 min", desc: "Le gagnant après 60 minutes de temps réglementaire (sans prolongation)" },
  double_chance:           { label: "Double chance (60 min)", short: "Double chance", desc: "Deux des trois issues à 60 minutes : une équipe ou le nul, ou pas de nul" },
  game_to_ot:              { label: "Le match va en prolongation", short: "Prolongation", desc: "Le match ne se décide pas en temps réglementaire" },
  both_teams_score:        { label: "Les deux équipes marquent", short: "Les deux marquent", desc: "Chaque équipe marque au moins un but" },
  winning_margin:          { label: "Écart à la victoire", short: "Écart", desc: "L'écart exact de buts du gagnant", unit: "buts" },
  alt_puck_line:           { label: "Écart alternatif", short: "Écart alt.", desc: "Autres écarts de buts (−2,5, +2,5, etc.)", unit: "buts" },
  ot_winner:               { label: "Vainqueur en prolongation", short: "Vainqueur prol.", desc: "Qui gagne si le match va en prolongation ou en tirs de barrage" },
  period1_winner:          { label: "Vainqueur de la 1re période", short: "Vainqueur P1", desc: "L'équipe qui mène à la fin de la 1re période" },
  period2_winner:          { label: "Vainqueur de la 2e période", short: "Vainqueur P2", desc: "L'équipe qui mène à la fin de la 2e période" },
  period3_winner:          { label: "Vainqueur de la 3e période", short: "Vainqueur P3", desc: "L'équipe qui mène à la fin de la 3e période" },
  highest_scoring_period:  { label: "Période la plus prolifique", short: "Meilleure période", desc: "La période où il y aura le plus de buts" },
  period1_total_goals:     { label: "Buts en 1re période (plus/moins)", short: "Total P1", desc: "Buts marqués en 1re période au-dessus ou au-dessous de la ligne", unit: "buts" },
  period2_total_goals:     { label: "Buts en 2e période (plus/moins)", short: "Total P2", desc: "Buts marqués en 2e période au-dessus ou au-dessous de la ligne", unit: "buts" },
  period3_total_goals:     { label: "Buts en 3e période (plus/moins)", short: "Total P3", desc: "Buts marqués en 3e période au-dessus ou au-dessous de la ligne", unit: "buts" },
  first_team_score:        { label: "Première équipe à marquer", short: "1er but", desc: "L'équipe qui marque le premier but du match" },
  last_team_score:         { label: "Dernière équipe à marquer", short: "Dernier but", desc: "L'équipe qui marque le dernier but du match" },
  team_total_goals:        { label: "Buts de l'équipe (plus/moins)", short: "Buts de l'équipe", desc: "Les buts d'une équipe au-dessus ou au-dessous de la ligne", unit: "buts" },
  team_pp_goals:           { label: "Buts en avantage numérique (plus/moins)", short: "Buts en AN", desc: "Buts en avantage numérique au-dessus ou au-dessous de la ligne", unit: "buts en AN" },
  clean_sheet:             { label: "Blanchissage", short: "Blanchissage", desc: "L'équipe n'accorde aucun but" },
  team_score_every_period: { label: "Marque à chaque période", short: "Chaque période", desc: "L'équipe marque au moins un but dans chacune des trois périodes" },
  total_penalties:         { label: "Minutes de pénalité du match (plus/moins)", short: "Pénalités", desc: "Minutes de pénalité des deux équipes au-dessus ou au-dessous de la ligne", unit: "min de pénalité" },
  anytime_goal:            { label: "Marque un but", short: "Marque", desc: "Le joueur marque au moins un but" },
  first_goal_scorer:       { label: "Premier buteur", short: "1er buteur", desc: "Le joueur marque le premier but du match" },
  last_goal_scorer:        { label: "Dernier buteur", short: "Dernier buteur", desc: "Le joueur marque le dernier but du match" },
  shots_ou:                { label: "Tirs au but (plus/moins)", short: "Tirs", desc: "Tirs au but du joueur au-dessus ou au-dessous de la ligne", unit: "tirs" },
  assists_ou:              { label: "Passes (plus/moins)", short: "Passes", desc: "Passes du joueur au-dessus ou au-dessous de la ligne", unit: "passes" },
  points_ou:               { label: "Points (buts + passes, plus/moins)", short: "Points", desc: "Points du joueur (B+A) au-dessus ou au-dessous de la ligne", unit: "points" },
  pp_point:                { label: "Point en avantage numérique", short: "Point en AN", desc: "Le joueur obtient un point en avantage numérique" },
  goalie_saves_ou:         { label: "Arrêts du gardien (plus/moins)", short: "Arrêts", desc: "Arrêts du gardien au-dessus ou au-dessous de la ligne", unit: "arrêts" },
  blocked_shots_ou:        { label: "Tirs bloqués (plus/moins)", short: "Tirs bloqués", desc: "Tirs bloqués par le joueur au-dessus ou au-dessous de la ligne", unit: "tirs bloqués" },
  hits_ou:                 { label: "Mises en échec (plus/moins)", short: "Mises en échec", desc: "Mises en échec du joueur au-dessus ou au-dessous de la ligne", unit: "mises en échec" },
  time_on_ice_ou:          { label: "Temps de glace (plus/moins)", short: "Temps de glace", desc: "Minutes de jeu du joueur au-dessus ou au-dessous de la ligne", unit: "min" },
  faceoff_wins_ou:         { label: "Mises au jeu gagnées (plus/moins)", short: "Mises au jeu", desc: "Mises au jeu gagnées par le centre au-dessus ou au-dessous de la ligne", unit: "mises au jeu" },
  penalty_minutes_ou:      { label: "Minutes de pénalité (plus/moins)", short: "Pénalités", desc: "Minutes de pénalité du joueur au-dessus ou au-dessous de la ligne", unit: "min de pénalité" },
};

const SELECTION_FR: Record<string, string> = {
  over: "Plus", under: "Moins", home: "Domicile", away: "Visiteur",
  home_1: "Domicile gagne par exactement 1", home_2plus: "Domicile gagne par 2+",
  away_1: "Visiteur gagne par exactement 1", away_2plus: "Visiteur gagne par 2+",
  P1: "1re période", P2: "2e période", P3: "3e période",
};

const CATEGORY_FR: Record<MarketDefinition["category"], string> = {
  match: "Match", team: "Équipe", player: "Joueur", period: "Périodes", special: "Spéciaux",
};

/** Une définition dans la langue de l'app (copie ; la source reste intacte). */
export function localizeMarket(m: MarketDefinition, lang: "en" | "fr"): MarketDefinition {
  if (lang !== "fr") return m;
  const fr = MARKET_FR[m.type];
  return {
    ...m,
    label: fr?.label ?? m.label,
    shortLabel: fr?.short ?? m.shortLabel,
    description: fr?.desc ?? m.description,
    lineUnit: m.lineUnit ? (fr?.unit ?? m.lineUnit) : m.lineUnit,
    selectionOptions: m.selectionOptions?.map((o) => ({ ...o, label: SELECTION_FR[o.value] ?? o.label })),
  };
}

/** Nom d'une catégorie de marchés dans la langue de l'app. */
export function categoryLabel(cat: MarketDefinition["category"], lang: "en" | "fr"): string {
  return lang === "fr" ? CATEGORY_FR[cat] : CATEGORY_LABELS[cat];
}
