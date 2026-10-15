/**
 * predictionEngine.ts
 * Real probability estimates using live NHL Stats API data.
 *
 * Team markets  → Log5 formula (win% from standings)
 * Player props  → Poisson distribution (per-game rates from player stats)
 * Futures       → Standings-rank-based prior
 *
 * Point d'entrée public, inchangé pour les appelants et les `vi.mock` des tests.
 * Le code vit dans `./prediction/` depuis le 2026-09-15 (le fichier faisait 1754 lignes) :
 *
 *   scoreModel.ts      maths (Log5, Poisson), loi jointe des scores, recherche d'équipe
 *   markets.ts         moneyline, totaux, puck line, props joueur, marchés d'équipe
 *   marginPeriods.ts   écart de victoire, prolongation, périodes, futures
 *   factors.ts         décomposition des facteurs affichée au client
 *   gameParlay.ts      probabilité exacte de plusieurs jambes d'un même match
 */

export {
  predictMoneyline,
  predictTotalGoals,
  predictPuckLine,
  predictAnytimeGoal,
  predictFirstGoalScorer,
  predictLastGoalScorer,
  predictShotsOU,
  predictAssistsOU,
  predictPointsOU,
  predictPPPoint,
  predictGoalieSaves,
  predictPositionBasedProp,
  predictOvertimeWinner,
  predictAltPuckLine,
  predictRegulationResult,
  predictTeamToScore,
  predictBothTeamsScore,
  predictCleanSheet,
  predictTeamPPGoal,
  predictPenaltyKill,
} from './prediction/markets';
export type {
  PositionPropEstimate,
} from './prediction/markets';
export {
  parseMarginBucket,
  predictMarginDistribution,
  predictWinningMargin,
  predictGameToOvertime,
  predictHighestScoringPeriod,
  predictPeriodWinner,
  predictPeriodTotalGoals,
  predictFutures,
} from './prediction/marginPeriods';
export type {
  MarginBucket,
  MarginSelection,
  PeriodSelection,
} from './prediction/marginPeriods';
export {
  buildRealFactors,
} from './prediction/factors';
export {
  isScoreDerivable,
  predictGameLegCorrelation,
  predictExactGameParlay,
} from './prediction/gameParlay';
export { OT_GOAL_SHARE } from './prediction/gameParlay';
export type {
  GameParlayLeg,
  GameParlayCorrelation,
  GamePlayerLeg,
} from './prediction/gameParlay';
